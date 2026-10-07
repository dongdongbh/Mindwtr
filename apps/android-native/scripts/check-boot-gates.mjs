import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const app = resolve(import.meta.dirname, '..');
const consoleState = {
    console: { info() { throw new Error('QuickJS stdout missing'); } },
    __mindwtrNative: { log() { throw new Error('logcat unavailable'); } },
};
vm.runInNewContext(readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8'), consoleState);
assert.doesNotThrow(() => consoleState.console.info('saved'));
// A body refused after metadata still settles its promise and lets the next reply drain.
{
    let sequence = 0, body = 0;
    const answers = [];
    const state = { __mindwtrNative: {
            nowMs: () => 0,
            log: () => { throw new Error('Body refusals must not log private exceptions'); },
            cryptoCall: () => { const id = String(++sequence); answers.push(JSON.stringify({ id, body: true })); return id; },
            ioNext: () => answers.shift() ?? '',
            ioBody: () => {
                if (++body === 1) throw new Error('private body exception');
                if (body === 2) return '!MindwtrNativeError:private body status';
                return 'AQ==';
            },
        },
    };
    vm.runInNewContext(readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8'), state);
    const first = assert.rejects(state.__mindwtrCryptoCall({ op: 'aesGcmSeal' }), /^Error: I\/O response body is unavailable$/);
    const second = assert.rejects(state.__mindwtrCryptoCall({ op: 'aesGcmSeal' }), /^Error: I\/O response body is unavailable$/);
    const third = state.__mindwtrCryptoCall({ op: 'aesGcmSeal' });
    assert.equal(state.__pumpTimers(), 3);
    await Promise.all([first, second]);
    assert.deepEqual(Array.from(await third), [1]);
    assert.equal(state.__pumpTimers(), 0);
}
// The URL polyfill parses a person's mailto: and tel: links as the platform URL does, so their open button shows.
for (const text of ['mailto:alex@example.com', 'tel:+1-555-0100', 'MAILTO:bea@example.com?subject=Hi', 'javascript:alert(1)', 'obsidian://people/alex', 'https://bea.example/fail']) {
    const parts = (url) => [url.protocol, url.pathname, url.search, url.hash, url.host, String(url)];
    assert.deepEqual(parts(new consoleState.URL(text)), parts(new URL(text)), text);
}
// Query values read as WHATWG (and RN's URL shim) read them: everything after the first "=", "+" as a space; a "+" in a
// query survives the polyfill's own String(url).
const queryPairs = (params) => { const pairs = []; params.forEach((value, key) => pairs.push([key, value])); return pairs; };
for (const text of ['mindwtr:///capture?title=a=b&note=Buy+milk+%2B+eggs&empty=&flag&x%20y=1+2', 'https://host/dav/?dir=a+b']) {
    assert.deepEqual(queryPairs(new consoleState.URL(text).searchParams), queryPairs(new URL(text).searchParams), text);
}
assert.equal(String(new consoleState.URL('https://host/dav/?dir=a+b')), 'https://host/dav/?dir=a+b');
// QuickJS has no Intl: the polyfill's Collator and localeCompare sort by the host's ICU collation keys (one bridge call per
// text and options), so titles order as in RN; without the bridge they fall back to a plain comparison.
{
    const polyfills = readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8');
    const calls = [];
    // A stand-in for Android's keys: accents and case folded first, as ICU's primary level does.
    const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const bridge = { log() {}, collationKey(text, options) { calls.push(`${options}|${text}`); return fold(text) + (options.startsWith('base:') ? '' : `\u0001${text}`); } };
    const withKeys = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(polyfills, withKeys);
    assert.deepEqual([...vm.runInContext("['Zoo', 'éclair', 'apple'].sort(new Intl.Collator().compare)", withKeys)], ['apple', 'éclair', 'Zoo']);
    assert.equal(vm.runInContext("'éclair'.localeCompare('Zoo')", withKeys), -1, 'localeCompare uses the ICU keys');
    assert.equal(vm.runInContext("'ÉCLAIR'.localeCompare('eclair', undefined, { sensitivity: 'base' })", withKeys), 0);
    assert.equal(new Set(calls).size, calls.length, 'one key per text and options');
    assert.equal(vm.runInContext("Object.keys(String.prototype).includes('localeCompare')", withKeys), false);
    const noKeys = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: { log() {} } });
    vm.runInContext(polyfills, noKeys);
    assert.deepEqual([...vm.runInContext("['b', 'a', 'C'].sort(new Intl.Collator().compare)", noKeys)], ['C', 'a', 'b'], 'the fallback without the bridge');
}
// Intl.DateTimeFormat and Date's toLocale*String go to the host's `dateTimeFormat` bridge (IcuDateTimeFormat.kt: Android's
// ICU, resolved as Hermes's Java does); the polyfill does Hermes's C++ part (Intl.cpp: the locales and options read,
// toLocale*String's defaults, TimeClip). A stand-in bridge on Node's own Intl proves the options pass through and every
// result is assembled exactly as Node's Intl gives it, over core's option sets.
{
    const polyfills = readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8');
    const specs = [];
    const bridge = {
        log() {},
        dateTimeFormat(spec, op, time) {
            specs.push(spec);
            const { locales, options } = JSON.parse(spec);
            try {
                const dtf = new Intl.DateTimeFormat(locales, options);
                return op === 'format' ? dtf.format(time) : JSON.stringify(op === 'formatToParts' ? dtf.formatToParts(time) : dtf.resolvedOptions());
            } catch (error) {
                return `!MindwtrNativeError:${error.message}`;
            }
        },
    };
    const dates = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(polyfills, dates);
    const run = (code) => vm.runInContext(code, dates);
    // The device check's option sets (host-entry.ts INTL_CHECK_OPTIONS): core's calls, then defaults, hour cycles and styles.
    const optionSets = vm.runInNewContext(/const INTL_CHECK_OPTIONS = (\[[\s\S]*?\]);\n/.exec(readFileSync(resolve(app, 'bundle/host-entry.ts'), 'utf8'))[1]);
    assert(optionSets.length >= 20);
    const times = [Date.UTC(2026, 8, 6, 8, 5, 9), Date.UTC(2026, 0, 1, 0, 30, 0), Date.UTC(1999, 11, 31, 23, 59, 59, 999)];
    for (const locale of ['en-US', 'de-DE', 'zh-CN', 'ja-JP']) {
        for (const options of optionSets) {
            const args = `${JSON.stringify(locale)}, ${JSON.stringify(options)}`;
            const node = new Intl.DateTimeFormat(locale, options);
            assert.deepEqual(JSON.parse(run(`JSON.stringify(new Intl.DateTimeFormat(${args}).resolvedOptions())`)), node.resolvedOptions(), args);
            for (const time of times) {
                const at = `${args} at ${new Date(time).toISOString()}`;
                assert.equal(run(`new Intl.DateTimeFormat(${args}).format(${time})`), node.format(time), `format ${at}`);
                assert.equal(run(`JSON.stringify(new Intl.DateTimeFormat(${args}).formatToParts(new Date(${time})))`), JSON.stringify(node.formatToParts(time)), `formatToParts ${at}`);
                for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
                    // A style the call cannot take is Node's TypeError and the polyfill's alike.
                    const expected = (() => { try { return new Date(time)[method](locale, options); } catch (error) { return error.name; } })();
                    assert.equal(run(`(() => { try { return new Date(${time}).${method}(${args}); } catch (error) { return error.name; } })()`), expected, `${method} ${at}`);
                }
            }
        }
    }
    // No arguments: the device's locale and time zone (RN's Sync screen history dates, core's resolvedOptions().locale reads).
    for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) assert.equal(run(`new Date(${times[0]}).${method}()`), new Date(times[0])[method]());
    assert.deepEqual(JSON.parse(run('JSON.stringify(Intl.DateTimeFormat().resolvedOptions())')), Intl.DateTimeFormat().resolvedOptions(), 'callable without new');
    // Hermes's format is a getter that keeps one bound function; formatToParts without a date formats now.
    assert.equal(run(`(() => { const dtf = new Intl.DateTimeFormat('de-DE', { weekday: 'long' }); const format = dtf.format; return format(${times[0]}) + (dtf.format === format); })()`), 'Sonntagtrue');
    assert.equal(run("new Intl.DateTimeFormat('en-US', { year: 'numeric' }).formatToParts()[0].value"), String(new Date().getFullYear()));
    // Hermes's errors: a bad time zone or option value (RangeError), a style with a field or a time style on a date call
    // (TypeError), an invalid time (RangeError); an invalid Date prints as "Invalid Date".
    for (const [code, name] of [["new Intl.DateTimeFormat('en', { timeZone: 'Mars/Base' })", 'RangeError'], ["new Intl.DateTimeFormat('en', { weekday: 'tiny' })", 'RangeError'],
        ["new Intl.DateTimeFormat('en', { dateStyle: 'short', day: 'numeric' })", 'TypeError'], ["new Date(0).toLocaleDateString('en', { timeStyle: 'short' })", 'TypeError'],
        ["new Intl.DateTimeFormat('en').format(NaN)", 'RangeError'], ["new Intl.DateTimeFormat('en', null)", 'TypeError']]) {
        assert.equal(run(`(() => { try { ${code}; return 'none'; } catch (error) { return error.name; } })()`), name, code);
    }
    assert.equal(run("new Date(NaN).toLocaleString('de-DE')"), 'Invalid Date');
    assert.equal(run("Object.keys(Date.prototype).length + Object.keys(new Intl.DateTimeFormat()).length"), 0, 'nothing enumerable added');
    assert(specs.length > 0 && specs.every((spec) => typeof JSON.parse(spec).options === 'object'), 'every call sends its locales and options');
    // Without the bridge (a VM gate) the English stand-in stays.
    const noDates = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: { log() {} } });
    vm.runInContext(polyfills, noDates);
    assert.equal(vm.runInContext("new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(new Date(2026, 8, 6))", noDates), 'Sunday');
    // The Kotlin side: one guarded callback, its formatter made in install (on the engine thread) and used only there, no IO;
    // the device check's cases run only in a debug build.
    const kotlin = (name) => readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core', name), 'utf8');
    const host = kotlin('CoreHost.kt');
    const icu = kotlin('IcuDateTimeFormat.kt');
    assert.match(host, /private fun install\(engine: QuickJSContext, database: \(\) -> SqliteBridge\) \{[\s\S]*?val dates = IcuDateTimeFormat\(\)\s+bridge\.setProperty\("dateTimeFormat", guarded \{ args -> dates\.reply\(args\[0\] as String, args\[1\] as String, \(args\[2\] as Number\)\.toDouble\(\)\) \}\)/);
    assert.equal(host.match(/IcuDateTimeFormat\(\)|dates\./g).length, 2, 'made once, used only by the bridge callback');
    assert.doesNotMatch(icu, /java\.io|java\.nio|\bFile\b|Thread|Executor|\bLog\.|debugProperty|synchronized|Volatile|quickjs|getprop/, 'pure: no IO, no threads');
    assert.match(host, /if \(debugFault\("intl_check"\) == "1"\) engine\.globalObject\.setProperty\("__mindwtrIntlCheck", true\)/);
}
// A context automation link names a context with a space as "+" (core's parseContextAutomationUrl reads the query).
assert.equal(new consoleState.URL('mindwtr://contexts?token=home+office&contextAction=activate').searchParams.get('token'), 'home office');
assert.equal(new consoleState.URL('mindwtr://activate-context?name=%40home+office%2Bgym').searchParams.get('name'), '@home office+gym');
// Query decoding is forgiving like the platform URL parser; response-body decoding stays fatal by default.
for (const init of ['?task=%', '?task=%A', '?task=%GG', '?task=%E0%A4%A', '?task=%E0%A4', '?task=%80',
    '?task=%C0%AF', '?task=%ED%A0%80', '?task=%F4%90%80%80', '?task=%F0%9F%98%80',
    '?task=home+office%2Bgym', '?task=漢😀', '?task=%EF%BB%BFtask', '?task=\uD800',
    '?task=%E0%A4%A&task=valid&project=p', '?ta%73k=first&task=second']) {
    const expected = JSON.stringify([...new URLSearchParams(init)]);
    assert.equal(JSON.stringify([...new consoleState.URLSearchParams(init)]), expected, `query decode ${JSON.stringify(init)}`);
    assert.equal(JSON.stringify([...new consoleState.URL('mindwtr://open' + init).searchParams]), expected, `URL query decode ${JSON.stringify(init)}`);
}
// URLSearchParams.toString() has no "?", as WHATWG writes it: core posts it as a form body (dropbox-auth-tokens.ts) and puts
// its own "?" before it (sync-helpers.ts); String(url) still writes the "?" before a query.
for (const init of ['?a=1&b=x+y', 'a=1', '', { grant_type: 'refresh_token', refresh_token: 'r t+s' }, { a: 'x y', b: '1+1' }]) {
    assert.equal(new consoleState.URLSearchParams(init).toString(), new URLSearchParams(init).toString(), JSON.stringify(init));
}
for (const text of ['https://host/dav/?dir=a+b&_=1', 'https://host/dav/', 'mindwtr:///capture?title=a', 'mailto:alex@example.com?subject=Hi']) {
    assert.equal(String(new consoleState.URL(text)), String(new URL(text)), text);
}
// Core's log sanitizer walks a URL's query (sanitizeUrl: searchParams.keys()); a sync error's URL is logged that way.
for (const init of ['?token=1&a=2&token=3', '']) {
    const mine = new consoleState.URLSearchParams(init);
    const theirs = new URLSearchParams(init);
    assert.deepEqual([...mine.keys()], [...theirs.keys()], `keys() of ${init}`);
    assert.deepEqual([...mine.values()], [...theirs.values()], `values() of ${init}`);
    // The VM's pairs are another realm's arrays: compared as JSON.
    assert.equal(JSON.stringify([...mine.entries()]), JSON.stringify([...theirs.entries()]), `entries() of ${init}`);
    assert.equal(JSON.stringify([...mine]), JSON.stringify([...theirs]), `iterating ${init}`);
}
// Review S3 2 and 3: userinfo ends at the authority's LAST "@" (its password at the first ":"), and set() replaces the first
// pair and drops every later one, as WHATWG: core's sanitizer then removes a whole password and every repeated token.
for (const text of ['https://alice:p@ss@nas.local/dav', 'https://alice:a:b@nas.local:8443/dav?x=1', 'https://bob@nas.local/', 'https://nas.local/a@b']) {
    // WHATWG percent-encodes an "@" inside userinfo; the polyfill keeps it as typed: compared decoded.
    const parts = (url) => [decodeURIComponent(url.username), decodeURIComponent(url.password), url.host, url.pathname, url.search];
    assert.deepEqual(parts(new consoleState.URL(text)), parts(new URL(text)), text);
}
for (const [init, key] of [['?token=first&a=1&token=second', 'token'], ['?a=1', 'token'], ['?a=1&a=2&a=3', 'a']]) {
    const mine = new consoleState.URLSearchParams(init);
    const theirs = new URLSearchParams(init);
    mine.set(key, 'redacted');
    theirs.set(key, 'redacted');
    assert.equal(mine.toString(), theirs.toString(), `set(${key}) on ${init}`);
}
// fetch and the secret calls (HostIo.kt): the polyfill hands each call to the bridge and settles it only when the pump
// takes the host's answer (ioNext), as timers fire. A stand-in bridge answers here.
{
    const sent = [];
    // The host's queue: each answer's JSON, and its body apart (ioBody), as HostIo keeps them.
    const answers = [];
    let taken = '';
    const aborted = [];
    const store = new Map();
    const secretRequests = [];
    let clock = 0;
    let ids = 0;
    let nextCalls = 0;
    let bodyCalls = 0;
    const bridge = {
        log() {},
        nowMs: () => clock,
        netFetch(json) {
            const request = JSON.parse(json);
            if (request.url.startsWith('ftp:')) return '!MindwtrNativeError:Expected URL scheme \'http\' or \'https\'';
            sent.push(request);
            return String(++ids);
        },
        netAbort(id) { aborted.push(id); return null; },
        secretCall(json) {
            const request = JSON.parse(json);
            secretRequests.push(request);
            const { op, key, value } = request;
            if (!/^[\w.-]+$/.test(key)) return '!MindwtrNativeError:Invalid secret key';
            const id = String(++ids);
            if (op === 'set') store.set(key, value);
            if (op === 'delete') store.delete(key);
            answers.push({ json: JSON.stringify({ id, value: op === 'get' ? store.get(key) ?? null : null }) });
            return id;
        },
        ioNext() {
            nextCalls += 1;
            const next = answers.shift();
            taken = next?.body ?? '';
            return next?.json ?? '';
        },
        ioBody() { bodyCalls += 1; return taken; },
    };
    const net = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8'), net);
    const run = (code) => vm.runInContext(code, net);
    const answer = ({ base64, ...fields }) => answers.push(base64 === undefined
        ? { json: JSON.stringify(fields) } : { json: JSON.stringify({ ...fields, body: true }), body: base64 });
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const failure = async (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => ({ name: error.name, message: error.message }));
    const text = 'Grüße ✓ 😀';

    let settled = false;
    const get = run("fetch('https://dav.example/data.json', { headers: { 'Accept-Encoding': 'identity', Depth: '0' } })").then((res) => { settled = true; return res; });
    assert.deepEqual(sent.at(-1), { url: 'https://dav.example/data.json', method: 'GET', redirect: 'follow', headers: [['accept-encoding', 'identity'], ['depth', '0']] });
    answer({ id: '1', status: 207, statusText: 'Multi-Status', url: 'https://dav.example/data.json', redirected: false,
        headers: [['ETag', '"v1"'], ['X-A', '1'], ['x-a', '2']], base64: Buffer.from(JSON.stringify({ text })).toString('base64') });
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false, 'an answer settles only in the pump');
    assert.equal(net.__pumpTimers(), 1);
    const res = await get;
    assert.deepEqual([res.status, res.statusText, res.ok, res.body, res.headers.get('etag'), res.headers.get('X-A')], [207, 'Multi-Status', true, null, '"v1"', '1, 2']);
    assert.deepEqual(plain(await res.clone().json()), { text });
    assert.equal(await res.text(), JSON.stringify({ text }));
    assert.equal(res.bodyUsed, true);

    // Request bodies: text as text (RN's default type when none is set), bytes as base64, a form as its text.
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    net.bytes = bytes;
    const bodies = run("[fetch('https://dav.example/a', { method: 'put', body: 'Grüße' }),"
        + " fetch('https://dav.example/b', { method: 'PUT', body: new Uint8Array(bytes), redirect: 'error', headers: [['Content-Type', 'application/octet-stream']] }),"
        + " fetch('https://dav.example/c', { method: 'POST', body: new URLSearchParams('?a=1&b=%C3%BC') }),"
        + " fetch('https://dav.example/d', { method: 'PROPFIND', body: new Uint8Array(bytes).buffer })]");
    assert.deepEqual(sent.slice(-4).map(({ method, text: body, base64, headers, redirect }) => [method, body ?? base64, headers, redirect]), [
        ['PUT', 'Grüße', [['content-type', 'text/plain;charset=UTF-8']], 'follow'],
        ['PUT', Buffer.from(bytes).toString('base64'), [['content-type', 'application/octet-stream']], 'error'],
        ['POST', 'a=1&b=%C3%BC', [['content-type', 'application/x-www-form-urlencoded;charset=UTF-8']], 'follow'],
        ['PROPFIND', Buffer.from(bytes).toString('base64'), [], 'follow'],
    ]);
    // The answers: every byte back from base64, a failed request as RN's TypeError, the host's own refusal as it is.
    answer({ id: '3', status: 200, statusText: 'OK', url: 'https://dav.example/final', redirected: true, headers: [], base64: Buffer.from(bytes).toString('base64') });
    answer({ id: '2', error: 'Network request failed: Failed to connect to dav.example/10.0.0.1:443' });
    answer({ id: '4', error: 'fetch failed: unexpected redirect' });
    answer({ id: '5', status: 404, statusText: '', url: 'https://dav.example/d', redirected: false, headers: [], base64: '' });
    assert.equal(net.__pumpTimers(), 4);
    const [a, b, c, d] = await Promise.allSettled(bodies);
    assert.deepEqual([a.status, a.reason.name, a.reason.message], ['rejected', 'TypeError', 'Network request failed: Failed to connect to dav.example/10.0.0.1:443']);
    assert.deepEqual([b.value.url, b.value.redirected, Buffer.from(await b.value.arrayBuffer()).equals(Buffer.from(bytes))], ['https://dav.example/final', true, true]);
    assert.deepEqual([c.reason.name, c.reason.message], ['TypeError', 'fetch failed: unexpected redirect']);
    assert.deepEqual([d.value.status, d.value.ok, await d.value.text()], [404, false, '']);
    // A body is whole or the fetch rejects, never a short or empty body: core reads an unreadable sync document as a
    // missing remote and writes local data over it. HostIo answers a body cut short, a reset mid-body, an oversized body
    // and a broken gzip stream as errors; an answer whose body is not whole base64 is refused here.
    const whole = (base64) => ({ status: 200, statusText: 'OK', url: 'https://dav.example/data.json', redirected: false, headers: [], base64 });
    const cases = [
        ...['Network request failed: unexpected end of stream on http://127.0.0.1:18765/...', 'Network request failed: Connection reset',
            'Response exceeds the 104857600 byte download limit', 'Network request failed: gzip finished without exhausting source'].map((error) => [{ error }, error]),
        ...[undefined, 'eyJ0ZXh0Ijo', 'ey*0', 'e=J0', 'eyJ0ZX\u00e90', 'eyJ0\n'].map((base64) => [whole(base64), 'Network request failed: the host sent an unreadable body']),
    ];
    const cut = run(`[${cases.map((_, i) => `fetch('https://dav.example/cut/${i}')`).join(', ')}]`);
    cases.forEach(([fields], i) => answer({ id: String(ids - cases.length + i + 1), ...fields }));
    assert.equal(net.__pumpTimers(), cases.length);
    const outcomes = await Promise.allSettled(cut);
    outcomes.forEach((outcome, i) => {
        assert.equal(outcome.status, 'rejected', `case ${i} rejects`);
        assert.deepEqual([outcome.reason.name, outcome.reason.message], ['TypeError', cases[i][1]], `case ${i}`);
    });
    // Only a structured native cap reply marks the rejected Error. English text,
    // malformed metadata and an ordinary remote JSON body confer no authority.
    const capBeforeBody = bodyCalls;
    const capReply = run("fetch('https://dav.example/capped')");
    answer({ id: String(ids), error: 'Native cap fixture', errorCode: 'response-too-large', limitBytes: 4 });
    net.__pumpTimers();
    const capError = await capReply.then(() => assert.fail('native cap must reject'), (error) => error);
    assert.deepEqual([capError.name, capError.message, capError.code, capError.limitBytes],
        ['TypeError', 'Response exceeds the 4 byte download limit', 'response-too-large', 4]);
    assert.equal(bodyCalls, capBeforeBody, 'a coded refusal has no native body');
    for (const fields of [
        {}, { errorCode: 'response-too-large' }, { errorCode: 'response-too-large', limitBytes: '4' },
        { errorCode: 'response-too-large', limitBytes: 0 }, { errorCode: 'response-too-large', limitBytes: -1 },
        { errorCode: 'response-too-large', limitBytes: 1.5 }, { errorCode: 'response-too-large', limitBytes: Number.MAX_SAFE_INTEGER + 1 },
        { errorCode: 'other', limitBytes: 4 },
    ]) {
        const pending = run("fetch('https://dav.example/unmarked')");
        answer({ id: String(ids), error: 'Response exceeds the 4 byte download limit', ...fields });
        net.__pumpTimers();
        const error = await pending.then(() => assert.fail('malformed cap reply must reject'), (value) => value);
        assert.deepEqual([error.name, error.message, error.code ?? null, error.limitBytes ?? null],
            ['TypeError', 'Response exceeds the 4 byte download limit', null, null]);
    }
    const remoteMarker = run("fetch('https://dav.example/remote-marker')");
    answer({ id: String(ids), ...whole('eyJlcnJvckNvZGUiOiJyZXNwb25zZS10b28tbGFyZ2UiLCJsaW1pdEJ5dGVzIjo0fQ==') });
    net.__pumpTimers();
    const remoteResponse = await remoteMarker;
    assert.equal(remoteResponse.code, undefined);
    assert.deepEqual(plain(await remoteResponse.json()), { errorCode: 'response-too-large', limitBytes: 4 });
    // Whole base64 with its padding reads back exactly, the empty body included.
    const padded = run("['', 'QQ==', 'QUI=', 'QUJD'].map((_, i) => fetch('https://dav.example/pad/' + i))");
    ['', 'QQ==', 'QUI=', 'QUJD'].forEach((base64, i) => answer({ id: String(ids - 3 + i), ...whole(base64) }));
    net.__pumpTimers();
    assert.deepEqual(await Promise.all((await Promise.all(padded)).map((res) => res.text())), ['', 'A', 'AB', 'ABC']);
    // Refused before the bridge: a GET body, a method outside the list, a bad header; the host's own refusal is a TypeError too.
    const before = sent.length;
    for (const [code, message] of [
        ["fetch('https://dav.example', { body: 'x' })", /GET\/HEAD method cannot have body/], ["fetch('https://dav.example', { method: 'TRACE' })", /Unsupported method: TRACE/],
        ["fetch('https://dav.example', { headers: { 'Bad Name': 'x' } })", /Invalid header name/], ["fetch('ftp://dav.example')", /Expected URL scheme/],
    ]) {
        const error = await failure(run(code));
        assert.equal(error.name, 'TypeError', code);
        assert.match(error.message, message);
    }
    assert.equal(sent.length, before, 'a refused request never reaches the host');

    // Abort: the promise rejects at once with the signal's reason, the host cancels the call, and its late answer is dropped.
    const aborting = run("const controller = new AbortController(); globalThis.aborting = fetch('https://dav.example/slow', { signal: controller.signal }); controller.abort(); aborting");
    assert.deepEqual(await failure(aborting), { name: 'AbortError', message: 'This operation was aborted' });
    assert.deepEqual(aborted, [String(ids)]);
    const reasoned = run("const withReason = new AbortController(); const call = fetch('https://dav.example/slow', { signal: withReason.signal }); withReason.abort(new Error('Sync cancelled')); call");
    assert.equal((await failure(reasoned)).message, 'Sync cancelled');
    assert.deepEqual(await failure(run("fetch('https://dav.example', { signal: AbortSignal.abort() })")), { name: 'AbortError', message: 'This operation was aborted' });
    // AbortSignal.timeout fires on the host's timers: a TimeoutError once the clock passes it.
    const timed = run("fetch('https://dav.example/slow', { signal: AbortSignal.timeout(1000) })");
    clock = 999;
    net.__pumpTimers();
    clock = 1000;
    net.__pumpTimers();
    assert.deepEqual(await failure(timed), { name: 'TimeoutError', message: 'The operation timed out.' });
    assert.equal(aborted.length, 3);
    for (const id of aborted) answer({ id, error: 'Request cancelled', errorCode: 'response-too-large', limitBytes: 4 });
    assert.equal(net.__pumpTimers(), 0, 'a cancelled call\'s late answer settles nothing');
    const asked = nextCalls;
    net.__pumpTimers();
    assert.equal(nextCalls, asked, 'the pump asks the host only while a call is open');

    // Secrets: each call settles in the pump; a bad key is the host's refusal; a value must be a string.
    const secrets = net.__mindwtrSecrets;
    const saved = secrets.setSecret('mindwtr_webdav_password', text);
    net.__pumpTimers();
    assert.equal(await saved, undefined);
    const read = secrets.getSecret('mindwtr_webdav_password');
    net.__pumpTimers();
    assert.equal(await read, text);
    const removed = secrets.deleteSecret('mindwtr_webdav_password');
    net.__pumpTimers();
    await removed;
    const gone = secrets.getSecret('mindwtr_webdav_password');
    net.__pumpTimers();
    assert.equal(await gone, null);
    assert.deepEqual(await failure(secrets.getSecret('@mindwtr_webdav_password')), { name: 'TypeError', message: 'Invalid secret key' });
    assert.deepEqual(await failure(secrets.setSecret('mindwtr_cloud_token', 42)), { name: 'TypeError', message: 'A secret value must be a string' });
    assert.equal(answers.length, 0);

    // Review 1: text is fatal UTF-8. Core reads every response through `new TextDecoder()`: a malformed body throws, never
    // decodes to other text (E2 alone once read as U+2000, a space, so a body trimmed to empty read as a missing remote).
    // `fatal: false` gives the platform's replacement text, compared with Node's decoder.
    const malformed = [[0xe2], [0x20, 0xc0, 0xa0, 0x20], [0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80],
        [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80], [0xff], [0xe2, 0x82], [0x61, 0xe2, 0x28, 0xa1], [0xf0, 0x9f, 0x98]];
    net.cases = malformed.map((bytes) => new Uint8Array(bytes));
    for (const [i, bytes] of malformed.entries()) {
        assert.throws(() => run(`new TextDecoder().decode(cases[${i}])`), (error) => error.name === 'TypeError' && error.message === 'The encoded data was not valid for encoding utf-8', `fatal ${bytes}`);
        assert.equal(run(`new TextDecoder('utf-8', { fatal: false }).decode(cases[${i}])`), new TextDecoder().decode(Uint8Array.from(bytes)), `replacement ${bytes}`);
    }
    // Well-formed text, and 300 random byte strings without `fatal`, decode exactly as the platform decodes them.
    const random = Array.from({ length: 300 }, (_, i) => Uint8Array.from({ length: 1 + (i % 40) }, (_, j) => (i * 131 + j * 89 + ((i * j) % 7) * 37) & 0xff));
    net.random = random.map((bytes) => new Uint8Array(bytes));
    random.forEach((bytes, i) => assert.equal(run(`new TextDecoder('utf-8', { fatal: false }).decode(random[${i}])`), new TextDecoder().decode(bytes), `random ${i}`));
    const wellFormed = ['', 'plain', text, '\u0000\u007f\u0080\u07ff\u0800\uffff', '\u{10000}\u{10ffff}', 'a\u00e9\u4e2d\u{1f600}z'];
    net.wellFormed = wellFormed.map((value) => new TextEncoder().encode(value));
    wellFormed.forEach((value, i) => assert.equal(run(`new TextDecoder().decode(wellFormed[${i}])`), value));
    assert.equal(run('new TextDecoder().decode(new Uint8Array([0x78, 0x61, 0x62, 0x63, 0x78]).subarray(1, 4))'), 'abc', 'a view decodes from its offset');
    // The encoder writes a lone surrogate as U+FFFD, as the platform does, so the fatal decoder reads back what it wrote.
    for (const value of ['\ud800', 'a\udc00b', '\ud83d', '\udfff\ud800', '\ud83d\ude00']) {
        net.value = value;
        assert.deepEqual([...run('new TextEncoder().encode(value)')], [...new TextEncoder().encode(value)], JSON.stringify(value));
        assert.equal(run('new TextDecoder().decode(new TextEncoder().encode(value))'), new TextDecoder().decode(new TextEncoder().encode(value)));
    }
    // Response.text() and json() reject a body that is not UTF-8; arrayBuffer() stays byte-exact.
    const loose = run("fetch('https://dav.example/utf8')");
    answer({ id: String(ids), status: 200, statusText: 'OK', url: 'https://dav.example/utf8', redirected: false, headers: [], base64: Buffer.from([0x20, 0xe2, 0x20]).toString('base64') });
    net.__pumpTimers();
    const looseResponse = await loose;
    assert.deepEqual([...new Uint8Array(await looseResponse.clone().arrayBuffer())], [0x20, 0xe2, 0x20]);
    assert.deepEqual(await failure(looseResponse.clone().text()), { name: 'TypeError', message: 'The encoded data was not valid for encoding utf-8' });
    assert.deepEqual(await failure(looseResponse.json()), { name: 'TypeError', message: 'The encoded data was not valid for encoding utf-8' });

    // Review 2: the host's deadline passed. Every open fetch rejects with an AbortError and is cancelled at the host, and a
    // new fetch or secret call is refused (it never reaches the host) until the host resumes calls.
    const open = run("fetch('https://dav.example/slow')");
    const openId = String(ids);
    net.__cancelHostCalls('The host operation timed out');
    assert.deepEqual(await failure(open), { name: 'AbortError', message: 'The host operation timed out' });
    assert.equal(aborted.at(-1), openId);
    const refusedFrom = sent.length;
    assert.deepEqual(await failure(run("fetch('https://dav.example/after', { method: 'PUT', body: '{}' })")), { name: 'AbortError', message: 'The host operation timed out' });
    assert.deepEqual(await failure(secrets.setSecret('mindwtr_cloud_token', 'x')), { name: 'AbortError', message: 'The host operation timed out' });
    assert.equal(sent.length, refusedFrom, 'no call reaches the host while the operation drains');
    // Review 11: sync's secrets (host-sync.ts) are never refused. Another call's deadline must not fail a Save's commit
    // half-way (its URL written, its password refused) and leave sync off; a keystore call answers at once, so the drain ends.
    const syncSaved = net.__mindwtrSyncSecrets.setSecret('mindwtr_cloud_token', 'drained');
    net.__pumpTimers();
    assert.equal(await syncSaved, undefined);
    assert.equal(store.get('mindwtr_cloud_token'), 'drained', 'a sync secret write reaches the host while another call drains');
    net.__mindwtrHostPlatform = 'ios';
    const iosClass = net.__mindwtrSyncSecrets.setSecret('fixture', 'synthetic', 'after-first-unlock');
    net.__pumpTimers(); await iosClass;
    assert.deepEqual(secretRequests.at(-1), { op: 'set', key: 'fixture', value: 'synthetic', accessibility: 'after-first-unlock' });
    const iosDefault = net.__mindwtrSyncSecrets.setSecret('fixture', 'synthetic');
    net.__pumpTimers(); await iosDefault;
    assert.equal(Object.hasOwn(secretRequests.at(-1), 'accessibility'), false, 'Old iOS two-argument payload is unchanged');
    net.__mindwtrHostPlatform = 'android';
    const androidClass = net.__mindwtrSyncSecrets.setSecret('fixture', 'synthetic', 'after-first-unlock');
    net.__pumpTimers(); await androidClass;
    assert.equal(Object.hasOwn(secretRequests.at(-1), 'accessibility'), false, 'Android wire keeps its single existing class');
    net.__resumeHostCalls();
    run("fetch('https://dav.example/later')");
    assert.equal(sent.at(-1).url, 'https://dav.example/later', 'calls reach the host again once it resumes them');
}

// S4b: sync encryption's primitives on the host's crypto calls (host-polyfills.js __mindwtrCryptoCall, host-sync.ts
// createHostSyncCrypto) with core itself. The fake bridge answers as HostCrypto.kt does (Argon2id, AES-256-GCM, `auth` for a tag
// mismatch); HostCryptoTest proves the Kotlin bytes. Here: every byte crosses the base64 transport whole, an answer settles only in
// the pump, core opens and reproduces every MWENC1 vector, a tag mismatch is core's own SyncCryptoAuthError (core checks it with
// instanceof), and a host without the calls refuses every primitive.
{
    const { argon2id } = await import('@noble/hashes/argon2.js');
    const nodeCrypto = await import('node:crypto');
    const vectors = JSON.parse(readFileSync(resolve(app, '../../packages/core/src/__fixtures__/sync-crypto/vectors.json'), 'utf8'));
    const answers = [];
    const requests = [];
    let taken = '';
    let ids = 0;
    const b = (text) => Buffer.from(text, 'base64');
    const bridge = {
        log() {},
        nowMs: () => performance.now(),
        randomBytes: (length) => JSON.stringify([...nodeCrypto.randomBytes(length)]),
        cryptoCall(json) {
            const request = JSON.parse(json);
            requests.push(request);
            const id = String(++ids);
            try {
                let out;
                if (request.op === 'argon2id') out = argon2id(b(request.pass), b(request.salt), { m: request.m, t: request.t, p: request.p, dkLen: request.dkLen });
                else if (request.op === 'aesGcmSeal') {
                    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', b(request.key), b(request.nonce)).setAAD(b(request.aad));
                    out = Buffer.concat([cipher.update(b(request.data)), cipher.final(), cipher.getAuthTag()]);
                } else {
                    const data = b(request.data);
                    if (data.length < 16) throw Object.assign(new Error('wrong passphrase or corrupted data'), { auth: true });
                    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', b(request.key), b(request.nonce)).setAAD(b(request.aad));
                    decipher.setAuthTag(data.subarray(data.length - 16));
                    try { out = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]); }
                    catch { throw Object.assign(new Error('wrong passphrase or corrupted data'), { auth: true }); }
                }
                answers.push({ json: JSON.stringify({ id, body: true }), body: Buffer.from(out).toString('base64') });
            } catch (error) {
                answers.push({ json: JSON.stringify({ id, error: error.message, ...(error.auth ? { auth: true } : {}) }) });
            }
            return id;
        },
        ioNext() { const next = answers.shift(); taken = next?.body ?? ''; return next?.json ?? ''; },
        ioBody() { return taken; },
    };
    const entry = `import { createHostSyncCrypto } from './host-sync';
// Core's own file, not its index: esbuild never runs a lazily initialized module that an entry reaches only through the index.
import { SyncCryptoAuthError, SyncCryptoUnsupportedError, decryptSyncArtifact, deriveSyncKeyMaterial, encryptSyncArtifact } from '../../../packages/core/src/sync-crypto';
globalThis.cryptoGate = { prims: createHostSyncCrypto(globalThis.__mindwtrCryptoCall), refusing: createHostSyncCrypto(undefined),
    SyncCryptoAuthError, SyncCryptoUnsupportedError, decryptSyncArtifact, deriveSyncKeyMaterial, encryptSyncArtifact };`;
    const gateBundle = await build({ stdin: { contents: entry, loader: 'ts', resolveDir: resolve(app, 'bundle') }, bundle: true, write: false, format: 'iife', logLevel: 'silent' });
    const context = vm.createContext({ console: { info() {}, warn() {}, error() {}, log() {} }, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8'), context);
    vm.runInContext(gateBundle.outputFiles[0].text, context);
    const gate = context.cryptoGate;
    // Settles a crypto promise the way CoreHost's pump does: only __pumpTimers hands an answer back.
    const pumped = async (promise) => {
        let done = false;
        const settled = promise.finally(() => { done = true; });
        settled.catch(() => {}); // the caller takes the rejection; this only keeps Node from calling it unhandled meanwhile
        await new Promise((tick) => setImmediate(tick));
        assert.equal(done, false, 'a crypto call settles only in the pump');
        while (!done) { context.__pumpTimers(); await new Promise((tick) => setImmediate(tick)); }
        return settled;
    };
    const ContextBytes = vm.runInContext('Uint8Array', context);
    const u8 = (bytes) => new ContextBytes(bytes);
    for (const vector of vectors) {
        const material = await pumped(gate.deriveSyncKeyMaterial(vector.passphrase, u8(b(vector.saltB64)), vector.params, gate.prims));
        const encrypted = u8(b(vector.encryptedB64));
        const opened = await pumped(gate.decryptSyncArtifact(encrypted, material.key, gate.prims));
        assert(Buffer.from(opened).equals(b(vector.plaintextB64)), `${vector.name} opens through the host's calls`);
        // The same key, salt and nonce reproduce the container byte for byte.
        const nonce = encrypted.slice(34, 46);
        const sealed = await pumped(gate.encryptSyncArtifact(u8(b(vector.plaintextB64)), material, { ...gate.prims, randomBytes: () => nonce }));
        assert(Buffer.from(sealed).equals(b(vector.encryptedB64)), `${vector.name} seals byte for byte`);
    }
    const argonRequest = requests.find((request) => request.op === 'argon2id' && request.m === 19456);
    assert.deepEqual([argonRequest.t, argonRequest.p, argonRequest.dkLen, b(argonRequest.pass).toString()], [2, 1, 32, 'hunter2'], 'Argon2id\'s cost reaches the host as core asked it');
    // A changed byte: core's own SyncCryptoAuthError, so core reads it as a wrong passphrase, never as a transport failure.
    const first = vectors[0];
    const material = await pumped(gate.deriveSyncKeyMaterial(first.passphrase, u8(b(first.saltB64)), first.params, gate.prims));
    const tampered = u8(b(first.encryptedB64));
    tampered[tampered.length - 1] ^= 1;
    const authError = await pumped(gate.decryptSyncArtifact(tampered, material.key, gate.prims)).then(() => null, (error) => error);
    assert(authError instanceof gate.SyncCryptoAuthError, 'a tag mismatch is core\'s SyncCryptoAuthError');
    const short = await pumped(gate.prims.aesGcmOpen(material.key, u8(new Uint8Array(12)), u8(new Uint8Array(15)), u8(new Uint8Array(0)))).then(() => null, (error) => error);
    assert(short instanceof gate.SyncCryptoAuthError, 'a body too short for a tag is an auth failure too');
    // A refused Argon2id cost (fewer than 8 KiB per lane) rejects, and core names it unsupported.
    const badParams = await pumped(gate.deriveSyncKeyMaterial('x', u8(new Uint8Array(16)), { mKib: 8, t: 1, p: 2 }, gate.prims)).then(() => null, (error) => error);
    assert(badParams instanceof gate.SyncCryptoUnsupportedError, 'an Argon2id refusal is core\'s SyncCryptoUnsupportedError');
    assert.equal(gate.prims.randomBytes(12).length, 12, 'random bytes come from the host at the asked length');
    // No crypto calls: every primitive refuses, so an encrypted location fails closed instead of syncing plaintext.
    await assert.rejects(gate.refusing.argon2id(u8([1]), u8(new Uint8Array(16)), { mKib: 64, t: 1, p: 1 }, 32), /Sync encryption is not available/);
    await assert.rejects(gate.refusing.aesGcmSeal(u8(new Uint8Array(32)), u8(new Uint8Array(12)), u8([1]), u8([])), /Sync encryption is not available/);
    assert.throws(() => gate.refusing.randomBytes(12), /Sync encryption is not available/);
    // The bridge: started on the engine thread, run on HostIo's crypto thread, its callback guarded; never refused after a deadline.
    const kotlinCore = (name) => readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core', name), 'utf8');
    const coreHostSource = kotlinCore('CoreHost.kt');
    const hostIoSource = kotlinCore('HostIo.kt');
    assert.match(coreHostSource, /bridge\.setProperty\("cryptoCall", guarded \{ args -> io\.crypto\(args\[0\] as String\) \}\)/);
    assert.match(hostIoSource, /private val cryptoThread = Executors\.newSingleThreadExecutor/);
    assert.match(hostIoSource, /cryptoThread\.execute \{\s+val reply = runCatching \{ cryptoReply\(id, json\) \}\.getOrElse/, 'a crypto failure, an OutOfMemoryError included, is an answer, never a crash');
    // Review S4b 3 (and its verification): once the host closed, no answer of any kind (a secret's value, a derived key, a
    // plaintext, a fetch body) is queued or taken, and close drops what waited (HostAnswers, HostAnswersTest). Every answer goes
    // through the one HostAnswers queue; HostIo keeps no queue or held answer of its own.
    const hostAnswersSource = kotlinCore('HostAnswers.kt');
    assert.match(hostIoSource, /private val answers = HostAnswers\(\)/);
    assert.doesNotMatch(hostIoSource, /LinkedBlockingQueue|private var held|private var taken/);
    assert.match(hostIoSource, /answers\.close\(\)\s+cryptoThread\.shutdownNow\(\)/);
    assert.match(hostIoSource, /return HostCrypto\.answer\(\{ answers\.closed \}, compute\)/);
    assert.match(hostIoSource, /fun next\(\): String \{\s+val answer = answers\.next\(\) \?: return ""/);
    assert.match(hostIoSource, /fun body\(\): String = answers\.body\(\)/);
    assert.match(hostAnswersSource, /fun add\(answer: Answer\): Boolean = synchronized\(lock\) \{ if \(closed\) false else queue\.add\(answer\) \}/);
    assert.match(hostAnswersSource, /fun next\(\): Answer\? = synchronized\(lock\) \{\s+if \(closed\) return null/);
    assert.match(hostAnswersSource, /fun close\(\) = synchronized\(lock\) \{\s+closed = true\s+queue\.clear\(\)\s+held = null\s+taken = null\s+\}/);
    // Review S4b 2: Argon2id's cost is read as exact whole numbers (HostCrypto.argon2Params), never getInt's truncation.
    assert.match(hostIoSource, /val \(m, t, p, dkLen\) = HostCrypto\.argon2Params\(request\)/);
    assert.doesNotMatch(hostIoSource, /getInt\("(m|t|p|dkLen)"\)/);
    const polyfillSource = readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8');
    assert.doesNotMatch(polyfillSource.slice(polyfillSource.indexOf('// --- sync crypto'), polyfillSource.indexOf('// --- localStorage')), /refuseIfCancelled/);
}
const coreHost = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/CoreHost.kt'), 'utf8');
const sqliteBridge = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/SqliteBridge.kt'), 'utf8');
const hostEntry = readFileSync(resolve(app, 'bundle/host-entry.ts'), 'utf8');
assert.match(hostEntry, /new ValidatedSqliteAdapter\(sqlite, \{ rejectConcurrentWrites: true \}\)/);
// Review 11: sync's service, its Save commit and its screen use the secrets no other call's deadline refuses.
assert.equal(/const nativeSyncBindings: NativeSyncBindings = \{[\s\S]*?localData:/.exec(hostEntry)?.[0].match(/__mindwtrSyncSecrets/g)?.length, 3, 'sync binds the unrefused secrets');
assert.match(hostEntry, /createNativeSync\(nativeSyncBindings\)/);
// Durable request receipts: core's adapter commits a write's receipt in its data's transaction (the hook right before
// COMMIT in both data saves, into native_request_receipts), and boot loads them before activation and the journal's replay.
{
    assert.match(hostEntry, /class ValidatedSqliteAdapter extends NativeReceiptSqliteAdapter \{/);
    const bootBody = hostEntry.slice(hostEntry.indexOf('const boot = '), hostEntry.indexOf('globalThis.MindwtrHost ='));
    const bootOrder = ['setStorageAdapter(adapter)', 'if (journaled) await loadNativeRequestReceipts(sqlite)', "else await loadNativeRequestReceipts(sqlite, { durableCommands: ['appLock', 'notificationSetting', 'deviceCalendarSetting', 'calendarSubscriptionSetting', 'calendarSubscriptionAdd', 'reminderComplete', 'reminderSnooze', 'taskCompletion', 'taskCompletionUndo', 'archivedTaskRestore', 'archivedTasksRestore', 'doneTasksMove', 'doneTasksAddTag', 'doneTasksRemoveTag', 'archivedTasksDelete', 'archivedTasksDeleteUndo', 'doneTasksDelete', 'doneTasksDeleteUndo', 'referenceTasksDelete', 'referenceTasksDeleteUndo', 'referenceTasksMove', 'referenceTasksAddTag', 'referenceTasksRemoveTag', 'preparedProjectLifecycle', 'preparedTaskDelete', 'preparedProjectDelete', 'preparedTaskDeleteUndo', 'doneTaskStatus', 'referenceTaskNext', 'referenceTaskStatus', 'referenceTaskCompletion', 'referenceTaskCompletionUndo', 'referenceTaskBackdate', 'referenceTaskDestination', 'referenceProjectNextAction', 'doneTaskCompletedAt', 'archiveTaskCompletedAt', 'data', 'backupDocument'] })", 'await adapter.getData()', 'await activateAndVerify(adapter'].map((text) => bootBody.indexOf(text));
    assert(bootOrder.every((index, i) => index > (i ? bootOrder[i - 1] : -1)), `receipts boot order ${bootOrder}`);
    assert.match(hostEntry, /pruneReceipts\(\): string \{\s*return submit\(async \(\) => \(\{ pruned: await pruneNativeRequestReceipts\(sqlite\) \}\)\);/);
    const coreAdapter = readFileSync(resolve(app, '../../packages/core/src/sqlite-adapter.ts'), 'utf8');
    assert.match(coreAdapter, /await this\.beforeCommit\(\{ data \}\);\s*saveStep = 'commit';\s*const commitStartedAt = Date\.now\(\);\s*await runTimed\('COMMIT'\);/);
    assert.match(coreAdapter, /await this\.beforeCommit\(\{ task \}\);\s*await this\.client\.run\('COMMIT'\);/);
    const coreReceipts = readFileSync(resolve(app, '../../packages/core/src/native-request-receipts.ts'), 'utf8');
    assert.match(coreReceipts, /CREATE TABLE IF NOT EXISTS native_request_receipts \(/);
    assert.match(coreReceipts, /class NativeReceiptSqliteAdapter extends SqliteAdapter \{[\s\S]*?protected override async beforeCommit\([\s\S]*?INSERT INTO native_request_receipts/);
}
assert.match(sqliteBridge, /PRAGMA synchronous = FULL/);
// Nothing writes the RN database before its .prewrite snapshot: the open sets only foreign_keys (a connection
// setting), and WAL (which rewrites a rollback-journal header) and synchronous follow VACUUM INTO or the
// validated existing snapshot.
const bridgeOpen = sqliteBridge.slice(sqliteBridge.indexOf('private val connection'), sqliteBridge.indexOf('private val statements'));
assert.deepEqual(bridgeOpen.match(/PRAGMA [^"]*/g), ['PRAGMA foreign_keys = ON']);
const bridgeCheckpoint = sqliteBridge.slice(sqliteBridge.indexOf('fun ensureRecoveryCheckpoint'), sqliteBridge.indexOf('private fun syncCheckpoint'));
const pragmaOrder = ['checkIntegrity(connection)', 'syncCheckpoint(checkpointFile)', 'exec("VACUUM INTO', 'syncDirectory(checkpointFile.parentFile!!)',
    'exec("PRAGMA journal_mode = WAL")', 'exec("PRAGMA synchronous = FULL")'].map((text) => bridgeCheckpoint.indexOf(text));
assert(pragmaOrder.every((index, i) => index > (i ? pragmaOrder[i - 1] : -1)), `SQLite pragma order ${pragmaOrder}`);
assert.equal(sqliteBridge.match(/journal_mode|synchronous =/g).length, 2);
assert.doesNotMatch(bridgeCheckpoint, /\breturn\b/);
assert.match(sqliteBridge, /syncFile\(partial\)[\s\S]*?renameTo\(checkpointFile\)[\s\S]*?syncDirectory/);
// Startup (phase 2 #3): SQLite opens and takes its checkpoint on the caller's thread while the engine loads the bundle. No SQL runs
// before the checkpoint: the bridge reaches SQLite only through the open's future, and boot starts after the engine took it.
{
    const start = coreHost.slice(coreHost.indexOf('fun start(bundle: CoreBundle'), coreHost.indexOf('/** Where the bundle came from'));
    const order = ['val opened = FutureTask {', 'database.ensureRecoveryCheckpoint()', 'val database = { opened.get() }', 'executor.submit(Callable {',
        'install(engine, database)', 'load(engine, database, bundle)', 'opened.run()', 'return onEngine {', 'loading.get()', 'sqlite = database()',
        'callAsync("boot", legacyState, legacyBackup, "journaled")'].map((text) => start.indexOf(text));
    assert(order.every((index, i) => index > (i ? order[i - 1] : -1)), `start order ${order}`);
    assert.match(start, /catch \(failure: Throwable\) \{\s+if \(sqlite == null\) runCatching \{ database\(\)\.close\(\) \}\s+closeOnEngine\(\)/, 'a failed start closes an open database it never handed over');
    assert.match(start, /catch \(error: Throwable\) \{\s+runCatching \{ database\.close\(\) \}\s+throw error/, 'a failed checkpoint closes its database');
    assert.equal(coreHost.match(/database\(\)\.(run|all|exec)\(/g).length, 3, 'the SQL calls take the database from the open\'s future');
    assert.equal(coreHost.match(/\bsqlite = (?!null)/g).length, 1, 'the engine takes the database once, at start');
}
const source = (name) => readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot', name), 'utf8');
const activity = source('MainActivity.kt');
const model = source('InboxViewModel.kt');
const owner = source('ProcessCoreHost.kt');
const editorUi = source('TaskEditor.kt');
const focusUi = source('FocusScreen.kt');
const projectsUi = source('ProjectsScreen.kt');
const labelsKt = source('Labels.kt');
const rowUi = source('TaskRowView.kt');
const areaUi = source('AreaSwitcher.kt');
const viewStateKt = source('ViewState.kt');
const searchUi = source('SearchScreen.kt');
const processUi = source('ProcessInbox.kt');
const captureUi = source('CaptureScreen.kt');
const captureModalUi = source('CaptureModal.kt');
const captureModalModel = source('CaptureModalModel.kt');
// The Menu tab (pass 6): its model, the More sheet, the shared widgets, and one file per list screen.
const menuModel = source('MenuModel.kt');
const moreUi = source('MoreSheet.kt');
// The Menu tab's sync dot: its opacity layer after the offset (a layer before it drew nothing on the S23).
assert.match(moreUi, /Box\(Modifier\.align\(Alignment\.TopEnd\)\.offset\(x = 7\.dp, y = \(-2\)\.dp\)\.size\(7\.dp\)\.fade\(0\.85f\)\.clip\(CircleShape\)\.background\(dot\)/);
const menuUi = source('MenuWidgets.kt');
const waitingUi = source('WaitingScreen.kt');
const somedayUi = source('SomedayScreen.kt');
const statusListUi = source('StatusListScreen.kt');
const archiveUi = source('ArchiveScreen.kt');
// Pass 7: Contexts, Trash, Review and the Weekly and Daily Review, each in its own file, and core's list actions they send.
const contextsUi = source('ContextsScreen.kt');
const trashUi = source('TrashScreen.kt');
const reviewUi = source('ReviewScreen.kt');
const weeklyUi = source('WeeklyReviewScreen.kt');
const dailyUi = source('DailyReviewScreen.kt');
const listActionsKt = source('ListActions.kt');
const reviewScreens = { contextsUi, trashUi, reviewUi, weeklyUi, dailyUi, listActionsKt };
// Pass 9: the Inbox tab on its view contract, the lists' selection mode (the bulk bar and its dialogs), and Focus's controls.
const inboxUi = source('InboxScreen.kt');
const bulkUi = source('BulkBar.kt');
const focusControlsUi = source('FocusControls.kt');
const focusModelKt = source('FocusModel.kt');
// Pass 11: a saved search's screen draws the menu list machinery's page (its model is MenuModel's).
const savedSearchUi = source('SavedSearchScreen.kt');
const menuScreens = { moreUi, menuUi, waitingUi, somedayUi, statusListUi, archiveUi, ...reviewScreens, inboxUi, bulkUi, focusControlsUi, savedSearchUi };
const snapshotsKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/RecoverySnapshots.kt'), 'utf8');
// Comments may name the rules below; only code is checked against them.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
// A failed read offers Try again; while a failed command's retry is owed, nothing else is offered.
assert.match(activity, /if \(failedAction == null\) TextButton\(onClick = \{ refresh\(\) \}, enabled = !busy, modifier = Modifier\.testTag\("read-retry"\)\)/);
// Every owed command keeps a reachable retry: each screen's failure banner offers Try again (retryOwed), which re-sends the
// exact recorded FailedAction, whatever screen or control started it (a status change from Focus's menu included).
assert.match(activity, /fun OwedRetry\(model: InboxViewModel\) \{\s+if \(model\.failedAction != null\) TextButton\(onClick = model::retryOwed, enabled = !model\.busy, modifier = Modifier\.testTag\("owed-retry"\)\)/);
// The read refresh and the owed retry are told apart (test tags): the checks assert the owed one only while a retry is owed.
assert.match(activity, /\} else OwedRetry\(model\)|else OwedRetry\(model\)/);
for (const [name, text] of Object.entries({ activity, editorUi, searchUi, processUi, menuUi, weeklyUi, dailyUi })) {
    assert.match(text, /FailureBanner\(message\) \{[\s\S]{0,320}?OwedRetry\(model\)/, `${name}: the failure banner offers the owed retry`);
}
{
    const retry = code(model.slice(model.indexOf('fun retryOwed()'), model.indexOf('\n    }\n', model.indexOf('fun retryOwed()'))));
    const kinds = new Set([...code(model + activity + editorUi + searchUi + processUi + rowUi).matchAll(/FailedAction\("(\w+)"/g)].map(([, kind]) => kind));
    for (const kind of [...kinds, 'inboxCommit', 'inboxSkip']) assert.match(retry, new RegExp(`"${kind}"`), `retryOwed re-sends a failed ${kind}`);
    assert.match(retry, /"update" -> sendUpdate\(action\)/);
    assert.match(retry, /"saveDraft" -> sendDraft\(action\)/);
    assert.match(retry, /"inboxCommit", "inboxSkip" -> sendAnswer\(action,/);
}
assert.match(rowUi, /failedAction == null \|\| failedAction == completeAction\(task\.id, task\.taskRevision\)/);
// Every task row carries core's revision (NativeTaskRow.taskRevision), parsed as core sent it; Kotlin never computes one.
assert.match(model, /text\("revealLabel"\), getBoolean\("laterToday"\), optString\("taskRevision"\)\)/);
assert.match(model, /fun completeAction\(id: String, taskRevision: String\) = FailedAction\("complete", id, patch = mapOf\("taskRevision" to taskRevision\)\)/);
// The swipe is core's meta.swipe (RN's getLeftAction moved to core); it and TalkBack's custom action are one command with one enabled rule.
// Done keeps core's completeTask and its retry; Restore and Next are the status change with theirs. RN draws no Done button.
assert.match(rowUi, /val target = meta\.swipe\.target\s+val swipeLabel = meta\.swipe\.label/);
assert.match(model, /meta\.getJSONObject\("swipe"\)\.let \{ RowSwipe\(it\.getString\("target"\), it\.getString\("label"\), it\.getString\("icon"\)\) \}/);
// No Kotlin status-to-swipe map: no status literal decides a swipe target, label, or icon.
const STATUS = '"(?:inbox|next|waiting|someday|reference|done)"';
for (const [name, text] of Object.entries({ rowUi, model, focusUi, projectsUi, activity })) {
    assert.doesNotMatch(code(text), new RegExp(`${STATUS}(?:\\s*,\\s*${STATUS})*\\s*->\\s*${STATUS}`), `${name}: no status-to-swipe map in Kotlin`);
}
assert.doesNotMatch(code(rowUi), /swipeTarget|archived\.restoreToInbox/);
assert.match(rowUi, /when \(swipe\.icon\) \{ "restore" -> Lucide\.RotateCcw; "done" -> Lucide\.Check; else -> Lucide\.ArrowRight \}/);
// A list whose contract writes its rows (Contexts, the Review screens) sends its own status action, with the same enabled rule for swipe and TalkBack.
// A selecting row has no swipe; a list with core's bulk contract (RowActions without a status) keeps the row's own swipe.
assert.match(rowUi, /val listed = actions\?\.status\s+val swipeOn = !selecting && if \(listed != null\) canEdit else completable && \(if \(target == "done"\) canComplete else canMove\)/);
assert.match(rowUi, /val canMove = writable && !busy && \(failedAction == null \|\| failedAction == statusAction\(task, target\)\)/);
assert.match(rowUi, /val onSwipe = listed\?\.let \{ status -> \{ status\(target\) \} \} \?: \{ if \(target == "done"\) complete\(task\.id, task\.taskRevision\) else changeStatus\(task, target\) \}/);
assert.match(rowUi, /SwipeAction\(enabled = swipeOn, swipe = meta\.swipe, shape = shape, onSwipe = onSwipe, onMenu = \{ showStatusMenu\(task\) \}, onDelete = onDelete\)/);
assert.match(rowUi, /if \(swipeOn\) customActions = listOf\(CustomAccessibilityAction\(swipeLabel\) \{ onSwipe\(\); true \},\s*CustomAccessibilityAction\(t\("taskStatus\.changeStatus"\)\) \{ showStatusMenu\(task\); true \}\)/);
assert.doesNotMatch(code(rowUi + activity), /IconButton\(onClick = \{ complete\(/, 'no visible Done button: RN has none');
// RN's reveal-then-tap (#1275): the swipe only reveals the button; its tap runs the action, its long-press opens the status menu.
assert.match(rowUi, /\.combinedClickable\(enabled = enabled, role = Role\.Button, onLongClick = \{ settle\(0f\); onMenu\(\) \}\) \{ settle\(0f\); onSwipe\(\) \}/);
assert.match(rowUi, /onDragStopped = \{ settle\(if \(offset\.value > open \/ 2\) open else if \(offset\.value < left \/ 2\) left else 0f\) \}/, 'a drag only opens or closes the row');
// RN's Delete swipe exists only where a list's contract trashes rows with core's Undo; a selecting list has no swipe.
assert.match(rowUi, /val left = if \(onDelete != null\) -open else 0f/);
assert.match(rowUi, /val onDelete = actions\?\.delete\?\.takeIf \{ canEdit && !selecting \}/);
assert.doesNotMatch(code(rowUi), /SwipeToDismissBox|combinedClickable\([^)]*\)[^\n]*openEditor/, 'no one-gesture swipe; the row\'s own long-press stays free');
// Every failed command holds its exact retry, except an update or editor save core refused before writing.
assert.match(model, /internal val UPDATE_REFUSALS = listOf\("STALE_REVISION", "INVALID_INPUT", "TASK_NOT_FOUND"\)/);
assert.match(model, /private val REFUSABLE = setOf\("update", "saveDraft", "resetChecklist", "saveSearch", "inboxCommit", "inboxSkip", "capture", "captureLines", "capturePicker"\) \+ MENU_KINDS \+ CAPTURE_MODAL_KINDS \+ ATTACHMENT_KINDS/);
assert.match(model, /val refused = message\.startsWith\("STALE_REVISION"\) \|\| \(action\?\.kind in REFUSABLE && UPDATE_REFUSALS\.any \{ message\.startsWith\(it\) \}\)/);
// A command refused as stale wrote nothing: it is never owed (no retry loop on a revision that can never match), its lists are
// read again, and nothing shows but the conflict line of the editor save, the status menu and an open draft's Save.
assert.match(model, /stale = action != null && action\.kind !in STALE_SHOWN && message\.startsWith\("STALE_REVISION"\)/);
assert.match(model, /private val STALE_SHOWN = setOf\("saveDraft", "update", "calendarCreate", "manageEditor"\)/);
assert.match(model, /if \(stale\) acknowledged\(action!!\)\s+else ui \{/);
assert.match(model, /\(action != null && !refused\) \|\| message\.startsWith\("SAVE_FAILED"\)/);
// While a failed command's retry is owed, only that exact command runs: no read starts, and the retry
// keeps the failure on screen. A read's failure never replaces an owed command, in the ViewModel or the process record.
assert.match(model, /if \(busy \|\| runtime == null \|\| \(failedAction != null && failedAction != action\)\) return false\s+busy = true\s+if \(action != null\) commandAt = \+\+issued\s+if \(failedAction == null\) error = null/);
assert.equal(code(model).match(/\berror = null\b/g).length, 4, 'perform and a read\'s success (no retry owed), closeEditor, and an accepted edit clearing only a refused edit\'s message');
assert.match(model, /if \(error != null && error == editRefusal\) error = null/);
assert.match(model, /if \(failedAction == null\) error = null\s+\}/, 'a read\'s success never clears an owed retry\'s failure');
assert.match(model, /val owed = failedAction\?\.takeIf \{ action == null && it\.kind != "storage" \}\s+if \(owed == null\) \{\s+error = message[\s\S]{0,120}?if \(failed != null\) failedAction = failed/);
assert.match(owner, /if \(pending\.action\.kind == "storage" && failure\?\.action\?\.kind\.let \{ it != null && it != "storage" \}\) return/);
// User actions go through perform: the three commands with their action, the reads the user asked for without one.
assert.equal(code(model).match(/\bperform\(action\)/g).length, 15, 'complete, editor save, Reset checklist, task star, project star, status, project create, area filter, saved search, Process Inbox answer, the storage retry, the journal replay\'s retry, and the capture popup\'s capture, lines and picker create');
assert.equal(code(model).match(/\bperform\s*\{/g).length, 10, 'editor, reload, Try again, two More (Focus, a project), open project, open Process Inbox, open the capture popup, a Focus control\'s edit, Import .txt');
// Background reads (resume, each minute, after a command) never take busy, so they disable no control and never
// turn a user's tap away: only perform sets busy, and its guard knows nothing of reads in flight.
const backgroundFn = code(model.slice(model.indexOf('internal fun <T> background('), model.indexOf('internal fun perform(')));
assert.match(backgroundFn, /if \(runtime == null \|\| busy \|\| failedAction != null\) return\s+val mine = \+\+issued/);
assert.doesNotMatch(backgroundFn, /busy = /);
assert.equal(code(model).match(/\bbusy = true\b/g).length, 1, 'only a user action takes busy');
// A list the boot left for later (still null) waits for a running action to end instead of being dropped (startup review 1).
assert.match(model, /fun refreshFocus\(\) \{\s+\/\/[^\n]*\s+if \(focus == null && busy\) return menu\.whenIdle\(::refreshFocus\)\s+val depth = focus\.depth\(\)\s+val controls = menu\.focusControls\.state\.toString\(\)\s+background\(/);
assert.match(model, /fun refreshProjects\(\) \{\s+\/\/[^\n]*\s+if \(projects == null && busy\) return menu\.whenIdle\(::refreshProjects\)\s+val at = depth\(\)\s+background\(/);
assert.match(model, /private fun refreshAll\(\) \{\s+val at = depth\(\)\s+background\(Part\.entries, \{ runtime -> read\(runtime, at\) \}, ::showLists\)/);
// A command's lists are read again only after it succeeds (or was refused as stale), in the background, once busy is released.
assert.match(model, /try \{\s+\/\/[^\n]*\s+debugProperty\("delay_action_ms"\)\.toLongOrNull\(\)\?\.let\(Thread::sleep\)\s+work\(runtime\); done = true\s+\}/);
assert.match(model, /ui \{\s+busy = false\s+if \(\(done \|\| stale\) && action != null\) refreshAll\(\)\s+finished\?\.invoke\(\)\s+\}/);
assert.doesNotMatch(code(model.slice(model.indexOf('fun add()'), model.indexOf('fun openEditor('))), /read\(runtime/);
// Stale results never overwrite newer state: every list read takes a number; a command outdates every earlier read;
// a result is shown only if nothing newer was shown first (a background failure too).
// Freshness is per list (Inbox, Focus, Projects, the open project, the area filter): a faster single-list read never
// makes a full read after an area change drop its other lists, and an older read never overwrites a newer one.
assert.match(model, /internal fun fresh\(mine: Long, part: Part\) = \(mine > commandAt && mine > \(shownAt\[part\] \?: 0L\)\)\.also \{ if \(it\) shownAt\[part\] = mine \}/);
assert.match(model, /internal enum class Part \{ Focus, Projects, Project, ProjectDetails, Areas, Editor, TaskView, Search, Menu, More, MenuDialog \}/);
{
    const show = code(model.slice(model.indexOf('private fun showLists('), model.indexOf('internal fun readSucceeded(')));
    for (const part of ['Focus', 'Projects', 'Project', 'Areas']) assert.match(show, new RegExp(`if \\(fresh\\(mine, Part\\.${part}\\)\\)`), `a full read applies ${part} on its own`);
    assert.doesNotMatch(code(model), /\bfresh\(mine\)/, 'every freshness check names its list');
}
assert.match(backgroundFn, /if \(result\.isFailure && parts\.map \{ fresh\(mine, it\) \}\.none \{ it \}\) return@ui\s+result\.onSuccess \{ apply\(it, mine\) \}\.onFailure/);
assert.match(backgroundFn, /if \(busy \|\| failedAction != null\) return@onFailure/, 'a background failure never replaces an owed retry or a running action');
for (const read of ['fun refresh()', 'fun loadMoreFocus(', 'fun openProject(', 'fun loadMoreProject(']) {
    const body = code(model.slice(model.indexOf(read), model.indexOf('\n    }\n', model.indexOf(read))));
    assert.match(body, /val mine = \+\+issued[\s\S]*ui \{ (if \(fresh\(mine, Part\.\w+\)\)|showLists\(lists, mine\))/, `${read} shows its result only if nothing newer came first`);
}
assert.equal(code(model).match(/(?<!var )\bcommandAt = /g).length, 1, 'only a command\'s start outdates reads');
// The exact retry of a failed Done is enabled wherever its row shows: Inbox, Focus, and a project.
assert.match(rowUi, /val canComplete = writable && !busy &&\s*\(failedAction == null \|\| failedAction == completeAction\(task\.id, task\.taskRevision\)\)/);
// Only the capture draft survives process death; a restored unchanged draft reuses its capture UUID.
// The editor draft survives process death through a synced file in the no-backup folder; the Bundle holds only its key.
// The model is read again from core, and the saved edits go on top with their own bases.
assert.match(model, /private var editorKey: String\? = saved\.get<String>\("editorKey"\)/);
assert.doesNotMatch(code(model), /saved\["editor(?!Key)/, 'no editor model or draft in the Bundle');
assert.match(model, /EditorDrafts\(File\(app\.noBackupFilesDir, "editor"\)\)/);
assert.match(model, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(state\.toString\(\)\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\(key\)\)\)/);
assert.match(model, /TaskEditor\.restore\(readEditor\(runtime, draft\.getString\("id"\)\), draft\)/);
assert.match(editorUi, /put\("bases", JSONObject\(edited\.keys\.associateWith \{ base\(it\) \}\)\)/);
// An uncertain save's exact request is on disk before the call; after process death it is sent again before the draft unlocks.
assert.match(model, /val action = saveDraftAction\(current\)\s+pendingSave = action\s+keepEditor\(current\)\s+sendDraft\(action\)/);
// The pending save keeps its request UUID, so the re-send after process death answers core's receipt for the first send.
assert.match(model, /pendingSave\?\.let \{\s+state\.put\("pending", JSONObject\(\)\.put\("base", JSONObject\(it\.base\)\)\.put\("patch", JSONObject\(it\.patch\)\)\.put\("checklist", it\.title\)\.put\("requestId", it\.requestId\)\s+\.put\("attachments", it\.attachments\)\)\s+\}\s+drafts\.write\(key, state\)/);
assert.match(model, /val action = FailedAction\("saveDraft", restored\.id, pending\.optString\("checklist"\), base = map\("base"\), patch = map\("patch"\),\s+requestId = pending\.optString\("requestId"\), attachments = pending\.optString\("attachments"\)\)\s+failedAction = action\s+sendDraft\(action\)/);
// Unresolved typed text is an unsaved edit: Close asks, and Save waits for core, then saves.
assert.match(editorUi, /val dirty get\(\) = patch\.isNotEmpty\(\) \|\| waiting \|\| checklistChanged \|\| attachmentsChanged/);
// The draft's attachments (pass A2) count as RN's areDraftAttachmentsDirty counts them: id, uri, title and removal.
assert.match(editorUi, /listOf\(it\.getString\("id"\), it\.optString\("uri"\), it\.optString\("title"\), it\.optString\("deletedAt"\)\)/);
assert.match(readFileSync(resolve(app, '../../packages/core/src/task-draft.ts'), 'utf8'), /`\$\{attachment\.id\}\\0\$\{attachment\.uri \?\? ''\}\\0\$\{attachment\.title \?\? ''\}\\0\$\{attachment\.deletedAt \?\? ''\}`/);
assert.match(editorUi, /val leave = \{ if \(editor\.readOnly \|\| \(!editor\.dirty && !editsPending\)\) closeEditor\(\) else confirmLeave = true \}/);
assert.match(model, /if \(current\.waiting \|\| editsPending\) \{ saveQueued = true; return \}/);
assert.match(model, /if \(saveQueued && !resolved\.waiting && !editsPending\) \{ saveQueued = false; saveEditor\(\) \}/);
// Text the app puts in a field (a chosen suggestion) leaves the cursor at its end, as RN's TextInput does.
assert.match(editorUi, /if \(field\.text != value\) field = TextFieldValue\(value, TextRange\(value\.length\)\)\s+BasicTextField\(field, \{ typed -> field = typed;/);
// A chip's click, label, and state are one accessibility node: one-of-many choices are selectable (TalkBack says
// "selected" as RN does; uiautomator reports selected), and only on/off chips (quick tokens, after completion) toggle.
assert.match(editorUi, /\.semantics \{ contentDescription = description \}\s+\.then\(if \(toggle\) Modifier\.toggleable\(value = active, enabled = enabled, role = Role\.Button, onValueChange = \{ onClick\(\) \}\)\s+else Modifier\.selectable\(selected = active, enabled = enabled, role = Role\.Tab, onClick = onClick\)\)/);
assert.equal(code(editorUi).match(/toggle = true/g).length, 2, 'only the quick token chips and "Repeat after completion" toggle');
// RN's Waiting prompt: choosing Waiting asks for the person first, with core's people suggestions.
assert.match(editorUi, /if \(status == "waiting" && !active\) openWaitingPrompt\(\) else editFields\(mapOf\("status" to status\)\)/);
assert.match(model, /keepEditor\(current\.assignWaiting\(person\)\)\s+editFields\(mapOf\("status" to "waiting", "assignedTo" to person\)\)/);
// One host per process: the Activity and ViewModel never close it, and only the owner constructs it.
// The ViewModel's only onCleared stops its sync event listener (ProcessCoreHost keeps the listeners); it closes nothing.
const listenerOnly = /\n    override fun onCleared\(\) \{\n        ProcessCoreHost\.unlistenSync\(syncListener\)\n        super\.onCleared\(\)\n    \}\n/;
assert.match(model, listenerOnly);
for (const file of [activity, model.replace(listenerOnly, '\n'), editorUi, focusUi, projectsUi, labelsKt, rowUi, areaUi, viewStateKt, searchUi, processUi, captureUi, captureModalUi, captureModalModel, menuModel, ...Object.values(menuScreens)]) {
    assert.doesNotMatch(file, /close\(|onDestroy|onCleared|CoreHost\(/);
}
const guard = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/LegacyRnStoreGuard.kt'), 'utf8');
const themeKt = source('Theme.kt');
const iconsKt = source('Icons.kt');
const logFileKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/DiagnosticsLogFile.kt'), 'utf8');
const kotlinFiles = [activity, model, owner, editorUi, focusUi, projectsUi, labelsKt, themeKt, iconsKt, rowUi, areaUi, viewStateKt, searchUi, processUi, captureUi, captureModalUi, captureModalModel, snapshotsKt, coreHost, sqliteBridge, guard,
    menuModel, logFileKt, ...Object.values(menuScreens)];
assert.equal(kotlinFiles.join('\n').match(/(?<!class )CoreHost\(/g).length, 1);
// The dev build keeps its own database. The upgradetest build gets the RN database and RN's state
// only from the guard, before CoreHost exists: before any open of it, the checkpoint, and any core write.
assert.match(owner, /val legacy = if \(BuildConfig\.RN_STORAGE\) \{\s*LegacyRnStoreGuard\.requireClear\(app\.dataDir, File\(app\.cacheDir, "legacy-rn-guard"\)\)\s*\} else \{\s*null\s*\}\s*val installer = HostInstaller\(app\.filesDir, app\.cacheDir\)\s*val keyValue = RnKeyValue\(app\.getDatabasePath\("RKStorage"\)\)\s*val runtime = CoreHost\(legacy\?\.database \?: File\(app\.filesDir, "mindwtr-native-dev\.db"\), legacy\?\.let \{ app\.dataDir \}, HostIo\(app\),\s*File\(app\.filesDir, "journal"\), deviceStore\(app\),\s*File\(app\.filesDir, DiagnosticsLogFile\.RELATIVE_PATH\),\s*keyValue, HostFiles\(app\.filesDir, app\.cacheDir, content = AndroidContentSource\(app\)\), installer,\s*ReminderAlarms\(app, keyValue, checkpointRnState = \{ if \(legacy != null\) LegacyRnStoreGuard\.checkpointRnState\(app\.dataDir\) \}\),\s*HostWidgets\(app\) \{ appState \},\s*scheduleBackgroundSync = \{ on -> CoreWork\.scheduleSyncStored\(app, on\) \}\)\s*try \{\s*runtime\.start\([^\n]*, legacy\?\.bootState \?: "", legacy\?\.backup \?: ""\)/);
// RN's installer journal recovery runs at boot after the validated load and before the journal's replay, the first write that
// can reach files/attachments (pass A2); it is RN's own Kotlin, compiled as it is.
assert.match(owner, /loadTheme\(runtime, legacy\?\.theme\)\s*(?:\/\/[^\n]*\n\s*)*recoverInstalls\(installer\)\s*if \(replay\(runtime\)\) recovered\(app, runtime, deferSync = true\)/);
assert.match(readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8'), /include\(listOf\("AttachmentFileInstallerCore", "AndroidAttachmentInstallerFileOps"\)\.map \{ "main\/java\/\$installer\/\$it\.kt" \}\)/);
// RN's JVM tests of both, the file operations' hard-link fallback and errno names (#1139) included, run in this app's unit tests.
assert.match(readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8'), /include\(listOf\("AttachmentFileInstallerCoreTest", "AndroidAttachmentInstallerFileOpsTest"\)\.map \{ "test\/java\/\$installer\/\$it\.kt" \}\)/);
// The Kotlin host journals every write, and says so at boot: core then requires each write's replay tokens. Only this
// flag sets 'required'; iOS boots and recovers with none.
assert.match(coreHost, /callAsync\("boot", legacyState, legacyBackup, "journaled"\)/);
assert.equal(coreHost.match(/"journaled"/g).length, 1);
assert.match(hostEntry, /setNativeReplayTokens\(journaled \? 'required' : 'optional'\)/);
assert.match(hostEntry, /bootRecovery\(legacyState: string, legacyBackup: string\): string \{\s*return boot\(legacyState, legacyBackup, true\);/);
assert.equal(hostEntry.match(/setNativeReplayTokens\(/g).length, 1);
assert.equal(kotlinFiles.join('\n').match(/LegacyRnStoreGuard\.requireClear\(/g).length, 1);
assert.match(guard, /private const val DATABASE = "files\/SQLite\/mindwtr\.db"/);
assert.match(guard, /val database = File\(dataDir, DATABASE\)/);
// AsyncStorage first (unreadable, then an oversized backup), then a missing database with RN state and
// no backup, then quick_check; only a clear result may create the folder. json-ahead no longer blocks.
const decision = guard.slice(guard.indexOf('fun requireClear'), guard.indexOf('private fun readState'));
const order = ['"async-storage-unreadable"', '"json-too-large"', '"database-missing"', 'queryCopy(database, scratch)', '"database-unreadable"']
    .map((text) => decision.indexOf(text));
assert(order.every((index, i) => index > (i ? order[i - 1] : -1)), `guard order ${order}`);
assert.match(decision, /state\.backup == null && hasRnState\(dataDir, asyncStorage\)\) "database-missing"/);
assert.doesNotMatch(guard, /"json-ahead"/);
assert(guard.indexOf('check(blocked == null)') < guard.indexOf('database.parentFile!!.mkdirs()'));
assert.match(guard, /\/\/ ponytail: copies the whole database on every boot\. Skip it once a native-owned\s*\/\/ marker proves the last shutdown was clean\./);
// RKStorage and the RN database are only read as bytes: SQLite writes -wal/-shm even through a
// read-only connection, and a failed read-write open can checkpoint the WAL into the file on close.
const originalUses = [...guard.matchAll(/\b(asyncStorage|database|file|source)\.(\w+)/g)].map(([, name, member]) => `${name}.${member}`);
assert.deepEqual([...new Set(originalUses)].sort(), ['asyncStorage.exists', 'asyncStorage.path', 'database.exists', 'database.parentFile',
    'file.name', 'file.path', 'source.copyTo', 'source.exists', 'source.name']);
assert.equal(guard.match(/BundledSQLiteDriver\(\)\.open\(/g).length, 2);
assert.match(guard, /BundledSQLiteDriver\(\)\.open\(File\(scratch, file\.name\)\.path\)/);
// The one read-write open of an original is RKStorage in commitRnState, after its byte checkpoint, and it
// only deletes the json-ahead marker and sets the reconcile flag, in one transaction.
const commit = guard.slice(guard.indexOf('fun commitRnState'), guard.indexOf('private fun ensureRnStateCheckpoint'));
assert(commit.indexOf('ensureRnStateCheckpoint(asyncStorage') > 0
    && commit.indexOf('ensureRnStateCheckpoint(asyncStorage') < commit.indexOf('BundledSQLiteDriver().open(asyncStorage.path)'));
assert.equal(guard.match(/asyncStorage\.path\)/g).length, 1);
assert.deepEqual(commit.match(/"(BEGIN IMMEDIATE|COMMIT|ROLLBACK|DELETE FROM[^"]*|INSERT[^"]*|PRAGMA[^"]*)"/g), [
    '"PRAGMA synchronous = FULL"', '"BEGIN IMMEDIATE"', '"DELETE FROM catalystLocalStorage WHERE key = ?"',
    '"INSERT OR REPLACE INTO catalystLocalStorage VALUES (?, ?)"', '"COMMIT"', '"ROLLBACK"']);
assert.match(commit, /bindText\(1, JSON_AHEAD\)[\s\S]*bindText\(1, RECONCILED\)\s*it\.bindText\(2, "1"\)/);
// The checkpoint: each file synced, the folder synced, then promoted by rename, then the parent synced.
const rnCheckpoint = guard.slice(guard.indexOf('private fun ensureRnStateCheckpoint'), guard.indexOf('private fun hasRnState'));
assert.match(rnCheckpoint, /if \(!checkpoint\.exists\(\)\)[\s\S]*listOf\("", "-wal", "-journal", "-shm"\)[\s\S]*syncFile\(source\.copyTo[\s\S]*syncDirectory\(partial\)[\s\S]*renameTo\(checkpoint\)[\s\S]*syncDirectory\(checkpoint\.parentFile!!\)/);
assert.match(guard, /RN_STATE_CHECKPOINT = "files\/SQLite\/RKStorage\.prewrite"/);
// Kotlin reads, JS decides: no merge, and the backup is passed on as text, never parsed.
assert.doesNotMatch(code(kotlinFiles.join('\n')), /merge|JSONObject\((state\.)?backup|JSONArray\((state\.)?backup/i);
assert.match(guard, /return Opened\(database, bootState\.toString\(\), state\.backup \?: "", state\.language, state\.theme\)/);
// RN's device-local language is one more AsyncStorage row read from the byte copy, passed on as text.
assert.match(guard, /private const val LANGUAGE = "mindwtr-language"/);
assert.match(guard, /listOf\(JSON_AHEAD, RECONCILED, BACKUP_VERSION, LANGUAGE, THEME\)/);
assert.match(guard, /language = if \(LANGUAGE in sizes\) value\(LANGUAGE\) else null/);
// RN's device-local theme is one more row read the same way (theme-context.tsx THEME_STORAGE_KEY).
assert.match(guard, /private const val THEME = "@mindwtr_theme"/);
assert.match(guard, /theme = if \(THEME in sizes\) value\(THEME\) else null/);
assert.match(coreHost, /LegacyRnStoreGuard\.commitRnState\(checkNotNull\(rnDataDir\)/);
assert.equal(kotlinFiles.join('\n').match(/commitRnState\(/g).length, 2, 'defined once, called once from the guarded bridge callback');
assert.match(guard, /queryCopy\(asyncStorage, scratch\)/);
assert.match(guard, /for \(suffix in listOf\("", "-wal", "-journal"\)\)/);
assert.match(guard, /PRAGMA quick_check/);
const guardLog = /Log\.i\(CoreHost\.TAG, ("[\s\S]*?")\)\n/.exec(guard)?.[1] ?? '';
assert.match(guardLog, /releaseCheck=v1\.3\.3\/native-android-legacy-json-ahead-guard/);
assert.match(guardLog, /outcome=\$\{if \(blocked == null\) "clear" else "blocked"\}/);
for (const [, name] of guardLog.matchAll(/(\w+)=/g)) assert.doesNotMatch(name, /key|pass|user/i);
assert.equal(owner.match(/close\(\)/g).length, 1);
assert.match(owner, /catch \(failure: Throwable\) \{\s*runCatching \{ runtime\.close\(\) \}/);
assert.match(activity, /model\.attach\(\)/);
// A failed command's exact retry outlives its screen inside this process only.
assert.match(model, /val failed = if \(\(action != null[\s\S]*?ProcessCoreHost\.recordFailure\([\s\S]*?ui \{/);
// A failed update keeps its editor draft with the retry, so a new screen reopens the editor on it.
assert.match(model, /PendingFailure\(failed, message, menu\.page, editor, screen, focus, projects, project, areaFilter\)/);
assert.match(model, /pending\.menuPage\?\.let\(menu::restorePage\)/, 'a new screen shows the failed command\'s list page again');
assert.match(model, /pending\.editor\?\.let\(::keepEditor\)/);
// ...and a failure on Focus reopens Focus with its rows, since reads wait for the retry.
assert.match(model, /focus = pending\.focus\s+projects = pending\.projects\s+keepProject\(pending\.project\?\.projectId\)\s+project = pending\.project\s+show\(pending\.screen\)/);
assert.equal(model.match(/ProcessCoreHost\.failure\?\.let \{ pending -> ui \{ host = runtime; restore\(pending, storedProcessing, storedCapture\) \}/g).length, 2);
assert.match(model, /runtime\.completeTask\(id, taskRevision\)\s+acknowledged\(action\)/);
assert.match(model, /runtime\.saveTaskDraft\(action\.id, draftJson\(action\.base\), draftJson\(action\.patch\), action\.title, action\.attachments, action\.requestId\)\s+\} catch \(failure: Exception\) \{[\s\S]{0,300}?throw failure\s+\}\s+acknowledged\(action\)\s+(?:\/\/[^\n]*\s+)*if \(action\.attachments\.isNotEmpty\(\)\) attachments\.settleSaved\(runtime, action\.id, JSONObject\(action\.attachments\)\)\s+ui \{ closeEditor\(settle = false\) \}/);
// The new contract commands: each is a perform(action) with its exact retry, acknowledged only after core's reply.
for (const [call, fn] of [
    ['runtime\\.setTaskFocus\\(id, focused, taskRevision\\)', 'fun setTaskFocus('], ['runtime\\.setProjectFocus\\(id, focused, projectRevision\\)', 'fun setProjectFocus('],
    ['runtime\\.updateTask\\(action\\.id, json\\(action\\.base\\), json\\(action\\.patch\\), action\\.requestId\\)', 'private fun sendUpdate('],
    ['runtime\\.createProject\\(action\\.title, areaId, action\\.id\\)', 'fun createProject('], ['runtime\\.setAreaFilter\\(action\\.id\\)', 'private fun sendAreaFilter('],
]) {
    const body = model.slice(model.indexOf(fn), model.indexOf('\n    }\n', model.indexOf(fn)));
    assert.match(body, new RegExp(`perform\\(action\\) \\{ runtime ->\\s+(val reply = )?${call}\\s+acknowledged\\(action\\)`), `${fn} runs through perform(action) with its exact retry`);
}
// A star's retry re-sends the same target at the same revision; a new project's retry re-sends the same request UUID, kept with its draft.
assert.match(model, /FailedAction\("taskFocus", id, patch = mapOf\("focused" to "\$focused", "taskRevision" to taskRevision\)\)/);
assert.match(model, /FailedAction\("projectFocus", id, patch = mapOf\("focused" to "\$focused", "projectRevision" to projectRevision\)\)/);
// The rows' revisions are core's: CoreHost passes them straight to host-entry's complete, taskFocus and projectFocus.
assert.match(coreHost, /fun completeTask\(id: String, taskRevision: String\): JSONObject = callAsync\("complete", id, taskRevision\)/);
assert.match(coreHost, /fun setTaskFocus\(id: String, focused: Boolean, taskRevision: String\): JSONObject = callAsync\("taskFocus", id, focused, taskRevision\)/);
assert.match(coreHost, /fun setProjectFocus\(id: String, focused: Boolean, projectRevision: String\): JSONObject = callAsync\("projectFocus", id, focused, projectRevision\)/);
assert.match(projectsUi, /it\.getBoolean\("focusedWithoutNextAction"\), it\.optString\("projectRevision"\)\)/);
assert.match(model, /FailedAction\("createProject", projectRequestId, projectDraft, base = mapOf\("areaId" to areaId\)\)/);
for (const field of ['projectDraft', 'projectRequestId']) assert.match(model, new RegExp(`saved\\.get<String>\\("${field}"\\)`));
assert.match(model, /if \(action\.kind == "createProject"\) setProjectDraft\(action\.title, action\.base\["areaId"\], action\.id\)/, 'a new screen restores the owed create, never re-sends it');
// A refused star shows core's own text (RN's toast); an empty refusal shows nothing.
assert.match(model, /val blocked = reply\.optString\("blocked"\)\s+if \(blocked\.isNotEmpty\(\)\) ui \{ showToast\(reply\.getString\("blockedTitle"\), blocked\) \}/);
// The area filter is read with every list, so its label and the lists change together.
assert.match(model, /readOpen\(runtime, at\) else null,\s+AreaFilter\.parse\(runtime\.areaFilter\(\)\),\s+\)/);
// Startup (phase 2 #2): the boot reads only the tab on screen; Focus and Projects follow first content (or their tab opening, or a
// tab chosen while the boot ran). Every other full read (refreshAll) reads every list.
assert.match(model, /private fun read\(runtime: CoreHost, at: Depth, shown: Screen\? = null\) = Lists\(\s+if \(shown == null \|\| shown == Screen\.Focus\) readFocus\(runtime, null, at\.focus, at\.controls\) else null,\s+if \(shown == null \|\| shown == Screen\.Projects\) ProjectsView\.parse\(runtime\.projects\(\)\) else null,\s+at\.project,\s+if \(shown == null \|\| shown == Screen\.Projects\) readOpen\(runtime, at\) else null,/);
assert.equal(code(model).match(/\bread\(runtime, at\b[^)]*\)/g).join(' | '), 'read(runtime, at, screen) | read(runtime, at) | read(runtime, at)', 'the boot reads the tab on screen; a read\'s Try again and refreshAll read all');
assert.match(model, /fun contentShown\(\) \{\s+if \(focus == null\) refreshFocus\(\)\s+if \(projects == null\) refreshProjects\(\)\s+ProcessCoreHost\.contentShown\(\)\s+\}/);
assert.match(model, /loading = false\s+\/\/[^\n]*\s+if \(screen == Screen\.Focus && lists\.focus == null\) refreshFocus\(\)\s+if \(screen == Screen\.Projects && lists\.projects == null\) refreshProjects\(\)/);
// A list the boot did not read never closes the open project.
assert.match(model, /lists\.projects\?\.let \{ read ->\s+if \(fresh\(mine, Part\.Projects\)\) projects = read\s+if \(fresh\(mine, Part\.Project\)\) showProject\(lists\.projectId, lists\.project\)\s+\}/);
for (const [fn, js] of [['setTaskFocus', 'taskFocus'], ['setProjectFocus', 'projectFocus'], ['createProject', 'createProject'], ['areaFilter', 'areaFilter'], ['setAreaFilter', 'setAreaFilter']]) {
    assert.match(coreHost, new RegExp(`fun ${fn}\\([^)]*\\): JSONObject =\\s*callAsync\\("${js}"`), `CoreHost.${fn} reaches host method ${js}`);
}
assert.equal([activity, owner, editorUi, focusUi, projectsUi, rowUi, areaUi].join('\n').match(/\.setTaskFocus\(|\.setProjectFocus\(|\.createProject\(|\.setAreaFilter\(|\.areaFilter\(\)/g), null);
assert.equal(model.match(/clearFailure/g).length, 1);
assert.doesNotMatch(owner, /SharedPreferences|SavedStateHandle|File\(app\.filesDir, "(?!mindwtr-native-dev\.db"|SQLite\/mindwtr\.db"|journal")/);
assert.match(model, /ProcessCoreHost\.get\(/);
// Storage exceptions never cross the QuickJS JNI boundary.
assert.equal(coreHost.match(/JSCallFunction \{/g).length, 1, 'the only JS callback constructor is guarded');
const bridgeCallbacks = coreHost.match(/bridge\.setProperty\([^\n]*/g);
assert.equal(bridgeCallbacks.length, 41, 'the SQL calls, trace, nowMs, randomBytes, rnStateCommit, collationKey, dateTimeFormat, log, the fetch, secret and sync crypto calls, logFile, the key-value calls, hostEvent, the queue\'s file calls the attachment file, delete, abort and installer calls and the reminder alarms\' calls: and the widgets\' three calls, and the background sync\'s schedule: each guarded');
assert(bridgeCallbacks.includes('bridge.setProperty("fileAbort", guarded { args -> io.fileAbort(args[0] as String); null })'));
assert(bridgeCallbacks.includes('bridge.setProperty("fileDeleteNow", guarded { args -> files.deleteNow(args[0] as String); null })'));
// The attachment file port and the installer only start their call on the engine thread; HostIo's files thread runs it.
assert(bridgeCallbacks.includes('bridge.setProperty("fileCall", guarded { args -> io.file(args[0] as String, files::call) })'));
assert(bridgeCallbacks.includes('bridge.setProperty("installerCall", guarded { args -> io.file(args[0] as String, installer::call) })'));
// The JS host's events (sync's badge and cycles, an automatic sync's warning): handed on as text, a listener's failure swallowed.
assert(bridgeCallbacks.includes('bridge.setProperty("hostEvent", guarded { args -> runCatching { onEvent?.invoke(args[0] as String) }; null })'));
for (const line of bridgeCallbacks) assert.match(line, /^bridge\.setProperty\("\w+", guarded \{/);
// RN's AsyncStorage in place (plan D1): RKStorage's own table and statements, durable writes in one transaction, and a file it
// creates left at RN's user_version 1 (at 0, RN's SQLiteOpenHelper re-runs onCreate, fails, and deletes the database).
{
    const kv = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/RnKeyValue.kt'), 'utf8');
    const rnSupplier = readFileSync(resolve(app, '../../node_modules/@react-native-async-storage/async-storage/android/src/main/java/com/reactnativecommunity/asyncstorage/ReactDatabaseSupplier.java'), 'utf8');
    for (const pin of ['DATABASE_NAME = "RKStorage"', 'DATABASE_VERSION = 1', 'TABLE_CATALYST = "catalystLocalStorage"', 'KEY_COLUMN + " TEXT PRIMARY KEY, "', 'VALUE_COLUMN + " TEXT NOT NULL"']) {
        assert(rnSupplier.includes(pin), `AsyncStorage still has ${pin}`);
    }
    assert.match(kv, /"CREATE TABLE IF NOT EXISTS catalystLocalStorage \(key TEXT PRIMARY KEY, value TEXT NOT NULL\)"/);
    assert.match(kv, /"INSERT OR REPLACE INTO catalystLocalStorage VALUES \(\?, \?\)"/);
    assert.match(kv, /PRAGMA user_version"\)\.use \{ it\.step\(\); it\.getLong\(0\) \} == 0L\) \{[\s\S]*?connection\.exec\(CREATE\)\s+connection\.exec\("PRAGMA user_version = 1"\)/);
    assert.match(kv, /connection\.exec\("PRAGMA synchronous = FULL"\)/);
    assert.match(kv, /private fun write\(work: \(SQLiteConnection\) -> Unit\) = open \{ connection ->\s+connection\.exec\("BEGIN IMMEDIATE"\)/);
    assert.match(owner, /RnKeyValue\(app\.getDatabasePath\("RKStorage"\)\)/, 'the key-value store is RN\'s own RKStorage');
    for (const name of ['kvGet', 'kvSet', 'kvRemove', 'kvMultiGet', 'kvMultiSet', 'kvMultiRemove']) {
        assert(bridgeCallbacks.some((line) => line.startsWith(`bridge.setProperty("${name}", guarded { args -> `)), `${name} is guarded`);
    }
}
// The pending-captures queue's ports: app-private files only (HostFiles), RN's RKStorage for the last-applied record (RnKeyValue);
// only a debug build's stop runs before a delete.
for (const [name, call] of [['fileList', 'args -> files.list(args[0] as String)'], ['fileRead', 'args -> files.readText(args[0] as String)'],
    ['fileDelete', 'args -> queueStop(); files.delete(args[0] as String); null'], ['kvGet', 'args -> JSONArray().put(keyValue.get(args[0] as String) ?: JSONObject.NULL).toString()'],
    ['kvSet', 'args -> kvFault(); keyValue.set(args[0] as String, args[1] as String); null']]) {
    assert(bridgeCallbacks.includes(`bridge.setProperty("${name}", guarded { ${call} })`), `${name} reaches the queue's port and nothing else`);
}
assert.match(coreHost, /private fun queueStop\(\) \{\s+if \(debugFault\("queue_stop"\) != "delete"\) return/, 'the queue stop is debug-only');
assert.match(coreHost, /private fun kvFault\(\) = check\(debugFault\("fail_kv_set"\) != "1"\)/, 'the injected RKStorage failure is debug-only');
// fetch and the secrets (HostIo.kt, SecretStore.kt): started on the engine thread, run off it, answered only through the pump.
{
    const core = (name) => readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core', name), 'utf8');
    const hostIo = core('HostIo.kt');
    const secretStore = core('SecretStore.kt');
    for (const [name, call] of [['netFetch', 'args -> io.fetch(args[0] as String)'], ['netAbort', 'args -> io.abort(args[0] as String); null'],
        ['secretCall', 'args -> io.secret(args[0] as String)'], ['ioNext', '_ -> io.next()'], ['ioBody', '_ -> io.body()']]) {
        assert(bridgeCallbacks.includes(`bridge.setProperty("${name}", guarded { ${call} })`), `${name} starts or takes a call and nothing else`);
    }
    assert.doesNotMatch(hostIo + secretStore, /quickjs|JSFunction|JSObject|JSCallFunction/i, 'no host call touches the engine');
    assert.match(hostIo, /calls\[id\] = call\s+call\.enqueue\(object : Callback \{/, 'a request runs on OkHttp\'s dispatcher');
    // The one wait: a debug build's Argon2id delay on the crypto thread (check-encryption-device.mjs taps during it).
    assert.doesNotMatch(hostIo.replace('if (argon2DelayMs > 0) Thread.sleep(argon2DelayMs).also { started = System.nanoTime() }', ''), /\.execute\(\)|runBlocking|Thread\.sleep/);
    assert.match(hostIo, /private val argon2DelayMs = debugProperty\("crypto_delay_ms"\)/);
    // Nothing throws on OkHttp's thread, and (review 3) a call stays cancellable until its body is read: it leaves [calls]
    // only after the read, on a failure, or on an abort, so an abort or close after the headers still cancels it.
    assert.match(hostIo, /override fun onResponse\(call: Call, response: Response\) \{[^{}]*?try \{\s*answers\.add\(runCatching \{ response\.use \{ read\(id, it, redirect\) \} \}\.getOrElse \{ failure\(id, call, it\) \}\)\s*\} finally \{\s*calls\.remove\(id\)\s*\}/);
    assert.equal(hostIo.match(/calls\.remove\(id\)/g).length, 3);
    assert.match(hostIo, /fun close\(\) \{\s*calls\.values\.forEach \{ it\.cancel\(\) \}/);
    assert.match(hostIo, /secretThread\.execute \{\s*\/\/ A read the closed host would never take is not made\.\s*if \(op == "get" && answers\.closed\) return@execute\s*answers\.add\(runCatching \{/, 'a secret call runs on the secrets thread');
    // A file call (the attachment file port, the installer) runs on the files thread, its request read there too.
    // A file call runs off the engine (FileJobs: the files thread, or a picked document's own thread), its request read there too;
    // an aborted call that has not started never runs (review finding 2).
    assert.match(hostIo, /fileJobs\.start\(id, FileJobs\.readsPickedDocument\(json\), \{\s*val request = JSONObject\(json\)/, 'a file call runs off the engine');
    const fileJobs = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/FileJobs.kt'), 'utf8');
    assert.match(fileJobs, /if \(aborted\.remove\(id\)\) throw IOException\("Request cancelled"\)/);
    assert.match(fileJobs, /if \(readsDocument\) Thread\(job, "mindwtr-document-\$id"\)\.apply \{ isDaemon = true \}\.start\(\) else queue\.execute\(job\)/);
    assert.equal(hostIo.match(/answers\.add\(/g).length, 5, 'the answer queue is the only way back');
    // A body leaves apart from its answer's JSON (ioBody), and only for the answer just taken.
    const hostAnswers = core('HostAnswers.kt');
    assert.match(hostAnswers, /held = null\s+taken = answer\.body\s+answer\s+\}/);
    assert.match(hostAnswers, /fun body\(\): String = synchronized\(lock\) \{ if \(closed\) "" else \(taken \?: ""\)\.also \{ taken = null \} \}/);
    // The whole body or a throw: the declared length and the running size are refused past the limit, and nothing in the
    // read catches a failure (a cut, a reset, a broken gzip stream) into a short body.
    const read = hostIo.slice(hostIo.indexOf('private fun read('), hostIo.indexOf('private fun failure('));
    assert.match(read, /if \(body\.contentLength\(\) > maxResponseBytes\) throw Refused\(tooLarge\)/);
    assert.match(read, /while \(source\.read\(bytes, 64 \* 1024L\) != -1L\) \{\s*if \(bytes\.size > maxResponseBytes\) throw Refused\(tooLarge\)\s*\}/);
    assert.doesNotMatch(read, /catch|runCatching|getOrNull|getOrDefault|getOrElse|\?: ""|orEmpty/, 'HostIo.read swallows no IOException');
    // The only places HostIo catches: each turns the failure into the call's error answer, so fetch rejects.
    assert.doesNotMatch(hostIo, /catch \(|getOrNull|getOrDefault/);
    assert.deepEqual(hostIo.match(/runCatching \{[\s\S]*?\}\.getOrElse \{ [^\n]*/g).map((line) => /getOrElse \{ (failure\(id, call, it\)|(Answer\()?JSONObject\(\)\.put\("id", id\)\.put\("error")/.test(line)), [true, true, false]);
    // A crypto call's failure (S4b) is its error answer too: `auth` for a tag mismatch, else the failure's own text.
    assert.match(hostIo, /runCatching \{ cryptoReply\(id, json\) \}\.getOrElse \{ failure ->\s+val answer = JSONObject\(\)\.put\("id", id\)[\s\S]{0,400}?Answer\(answer\.toString\(\)\)\s+\}\s+\/\/[^\n]*\s+if \(reply != null\) answers\.add\(reply\)\s+wake\(\)/);
    // A file call's failure (FileJobs runs it in runCatching and delivers the Result) is its error answer.
    assert.match(fileJobs, /val result = runCatching \{[\s\S]*?compute\(\)\s*\}[\s\S]*?deliver\(result\)/);
    assert.match(hostIo, /\}\) \{ Answer\(JSONObject\(\)\.put\("id", id\)\.put\("error", it\.message \?: it\.javaClass\.simpleName\)\.toString\(\)\) \}\)/);
    // Review 5: the ceiling is core's largest limit (a sync document), bounded by a fifth of the heap; core applies its
    // smaller limits itself. The lower limit the net check uses exists only in a debug build (debugProperty is "" in release).
    const coreHttp = readFileSync(resolve(app, '../../packages/core/src/http-utils.ts'), 'utf8');
    const product = (text) => text.replace(/[L_]/g, '').split('*').reduce((total, part) => total * Number(part.trim()), 1);
    assert.equal(product(/const val MAX_SYNC_DOCUMENT_BYTES = ([^\n]+)/.exec(hostIo)[1]), product(/export const MAX_SYNC_DOCUMENT_BYTES = ([^;]+);/.exec(coreHttp)[1]));
    assert.match(hostIo, /private val ceiling = minOf\(MAX_SYNC_DOCUMENT_BYTES, Runtime\.getRuntime\(\)\.maxMemory\(\) \/ 5\)/);
    assert.match(hostIo, /private val maxResponseBytes = debugProperty\("net_max_bytes"\)\.toLongOrNull\(\)\?\.takeIf \{ it > 0 \}\?\.let \{ minOf\(it, ceiling\) \} \?: ceiling/);
    assert.match(hostIo, /Log\.i\(CoreHost\.TAG, "Native Android fetch limit bytes=\$maxResponseBytes ceiling=\$ceiling heap=/);
    // Review 4: a response without a body keeps its gzip label and is never decoded (cloud's HEAD failed on it).
    assert.match(read, /val bodiless = response\.request\.method == "HEAD" \|\| response\.code == 204 \|\| response\.code == 304 \|\| body\.contentLength\(\) == 0L/);
    assert.match(read, /val gzip = !bodiless && response\.header\("Content-Encoding"\)\.equals\("gzip", ignoreCase = true\)\s+val source = if \(gzip\) GzipSource/);
    // A network failure's text never carries core's invalid-JSON phrases (retry-utils.ts), which sync reads as a missing
    // remote and writes over: the host's list is core's, and a matching detail is replaced by the exception's name.
    const coreRetry = readFileSync(resolve(app, '../../packages/core/src/retry-utils.ts'), 'utf8');
    const corePhrases = [...coreRetry.slice(coreRetry.indexOf('export const isWebdavInvalidJsonError'), coreRetry.indexOf('export const isRetryableWebdavReadError')).matchAll(/normalized\.includes\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([.../INVALID_JSON_PHRASES = listOf\(([\s\S]*?)\)\n/.exec(hostIo)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), corePhrases);
    assert.match(hostIo, /detail\.isNotEmpty\(\) && INVALID_JSON_PHRASES\.none \{ detail\.lowercase\(\)\.contains\(it\) \}\s*\} \?: error\.javaClass\.simpleName/);
    // Review 2: an operation's deadline is the longest core timeout it wraps (core's storage and request timeouts for a
    // contract call; HostIo's request ceiling plus that for one that sends requests). Past it the operation is cancelled
    // (JS cancel: its signal, its fetches) and drained; one that does not end stops the host, so it never resumes.
    const coreStorage = readFileSync(resolve(app, '../../packages/core/src/store-settings.ts'), 'utf8');
    const deadline = product(/const val OPERATION_DEADLINE_MS = ([^\n]+)/.exec(coreHost)[1]);
    assert(deadline >= product(/export const DEFAULT_TIMEOUT_MS = ([^;]+);/.exec(coreHttp)[1]) && deadline >= product(/const STORAGE_TIMEOUT_MS = ([^;]+);/.exec(coreStorage)[1]));
    assert.match(coreHost, /const val NETWORK_DEADLINE_MS = HostIo\.CALL_TIMEOUT_MS \+ OPERATION_DEADLINE_MS/);
    assert.match(coreHost, /private fun callAsync\(method: String, vararg args: Any\?, deadlineMs: Long = deadlineOf\(method, args\.toList\(\)\)\): JSONObject = onEngine \{\s*stopped\?\.let \{ throw IllegalStateException\(it\) \}/);
    assert.match(coreHost, /val answer = pumpUntil\(id, deadlineMs\) \?: run \{[^}]*?call\("cancel", id\)\s*if \(pumpUntil\(id, DRAIN_MS\) == null\) \{[^}]*?stopped = reason[^}]*?closeOnEngine\(\)\s*throw IllegalStateException\(reason\)\s*\}\s*checkNotNull\(context\)\.globalObject\.getJSFunction\("__resumeHostCalls"\)\.call\(\)\s*schedulePump\(\)\s*throw IllegalStateException\("Core \$method timed out"\)/);
    assert.equal(coreHost.match(/pumpUntil\(/g).length, 3, 'callAsync pumps only through pumpUntil');
    assert.match(coreHost, /callAsync\("netCheck", port, deadlineMs = NETWORK_DEADLINE_MS\)/);
    assert.match(hostIo, /response\.use \{ read\(id, it, redirect\) \}/);
    // RN's connect timeout (#1150).
    const rnClient = readFileSync(resolve(app, '../mobile/modules/sync-file-lock/android/src/main/java/tech/dongdongbh/mindwtr/syncfilelock/SyncHttpClientPackage.kt'), 'utf8');
    assert.equal(/CONNECT_TIMEOUT_MS = ([\d_]+L)/.exec(hostIo)[1], /CONNECT_TIMEOUT_MS = ([\d_]+L)/.exec(rnClient)[1]);
    assert.match(hostIo, /\.connectTimeout\(CONNECT_TIMEOUT_MS, TimeUnit\.MILLISECONDS\)/);
    assert.match(coreHost, /if \(io\.busy\(\)\) io\.await\(if \(delay < 0\) 25L else minOf\(delay, 25L\)\)\s+else if \(delay > 0\) Thread\.sleep\(minOf\(delay, 25L\)\)/);
    assert.match(coreHost, /callAsync\("boot", legacyState, legacyBackup, "journaled"\)\.also \{ netCheck\(\) \}/);
    assert.match(coreHost, /val port = debugFault\("net_check"\)\.ifEmpty \{ return \}/, 'the net check is debug-only');
    // RN's network security config (cleartext as RN allows it, user CAs trusted), and the INTERNET permission.
    const rnConfig = /NETWORK_SECURITY_CONFIG_XML = `([\s\S]*?)`;/.exec(readFileSync(resolve(app, '../mobile/plugins/android-network-security-config.js'), 'utf8'))[1];
    assert.equal(readFileSync(resolve(app, 'android/app/src/main/res/xml/network_security_config.xml'), 'utf8'), rnConfig);
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/);
    assert.match(manifest, /<application\s+android:networkSecurityConfig="@xml\/network_security_config"/);
    // expo-secure-store's own names, read from RN's copy: the file, the entry, the key alias, the item's fields.
    const expo = (name) => readFileSync(resolve(app, '../../node_modules/expo-secure-store/android/src/main/java/expo/modules/securestore', name), 'utf8');
    const expoSource = expo('SecureStoreModule.kt') + expo('encryptors/AESEncryptor.kt') + expo('AuthenticationHelper.kt');
    for (const pin of ['SHARED_PREFERENCES_NAME = "SecureStore"', 'DEFAULT_KEYSTORE_ALIAS = "key_v1"', 'return "$keychainService-$key"',
        'UNAUTHENTICATED_KEYSTORE_SUFFIX = "keystoreUnauthenticated"', 'AES_CIPHER = "AES/GCM/NoPadding"', 'return "$AES_CIPHER:$baseAlias"',
        'return "${getKeyStoreAlias(options)}:$suffix"', 'AES_KEY_SIZE_BITS = 256', 'NAME = "aes"', 'CIPHERTEXT_PROPERTY = "ct"', 'IV_PROPERTY = "iv"',
        'GCM_AUTHENTICATION_TAG_LENGTH_PROPERTY = "tlen"', 'SCHEME_PROPERTY = "scheme"', 'USES_KEYSTORE_SUFFIX_PROPERTY = "usesKeystoreSuffix"',
        'KEYSTORE_ALIAS_PROPERTY = "keystoreAlias"', 'REQUIRE_AUTHENTICATION_PROPERTY = "requireAuthentication"', 'MIN_GCM_AUTHENTICATION_TAG_LENGTH = 96']) {
        assert(expoSource.includes(pin), `expo-secure-store still has ${pin}`);
    }
    for (const pin of ['getSharedPreferences("SecureStore", Context.MODE_PRIVATE)', 'SERVICE = "key_v1"', 'entry(key: String) = "$SERVICE-$key"',
        'ALIAS = "$CIPHER:$SERVICE:keystoreUnauthenticated"', 'LEGACY_ALIAS = "$CIPHER:$SERVICE"', 'CIPHER = "AES/GCM/NoPadding"', '.setKeySize(256)',
        '.put("ct", ', '.put("iv", ', '.put("tlen", spec.tLen)', '.put("scheme", "aes")', '.put("usesKeystoreSuffix", true)', '.put("keystoreAlias", SERVICE)',
        '.put("requireAuthentication", false)', 'check(tagBits >= 96)', 'Regex("^[\\\\w.-]+$")']) {
        assert(secretStore.includes(pin), `SecretStore has RN's ${pin}`);
    }
}
assert.match(coreHost, /setProperty\("log", guarded \{ args -> runCatching \{/);
assert.match(coreHost, /try \{ work\(args\) \} catch \(error: Throwable\) \{ NATIVE_ERROR \+/);
// Fault hooks exist only behind BuildConfig.DEBUG.
assert.equal(coreHost.match(/getprop/g).length, 1);
assert.match(coreHost, /private fun debugFault\(name: String\): String = debugProperty\(name\)/);
assert.match(coreHost, /fun debugProperty\(name: String\): String \{\s*if \(!BuildConfig\.DEBUG\) return ""/);
// The only other debug properties: the capture check's clipboard, put there for the field's real Paste, and the projects
// check's held user action (delay_action_ms, perform's worker thread; release builds read nothing).
assert.equal([activity, model, owner, editorUi, focusUi, projectsUi, labelsKt, captureUi].join('\n').match(/debugProperty\(/g).length, 2);
assert.match(captureUi, /withContext\(Dispatchers\.IO\) \{ debugProperty\("clipboard"\) \}\.takeIf \{ it\.isNotEmpty\(\) \}\?\.let \{ clipboard\.setText\(/);
// The command path's fault hook, and the same hook for a journal replay (a replay can meet a failed save too).
assert.equal(coreHost.match(/failCommits =/g).length, 2);
assert.match(coreHost, /failCommits = debugFault\("fail_commit"\) == "1"/);
assert.equal([activity, model, owner, editorUi, focusUi, projectsUi, labelsKt].join('\n').match(/failCommits|debugFault|getprop/g), null);
// The language override is the same debug-only property read, and it replaces only the stored language.
assert.match(coreHost, /fun language\(stored: String, system: String\): JSONObject =\s*callAsync\("language", debugFault\("language"\)\.ifEmpty \{ stored \}, system\)/);
assert.equal(coreHost.match(/debugFault\("language"\)/g).length, 1);
// The write-ahead journal (WriteJournal.kt). Every write goes through callAsync, the one call path: it is on disk before the
// engine sees it, and core's reply settles it. The write list is host-entry's task commands, and those call exactly core's
// write commands (the crash-safe table), so a new write cannot skip the journal. The fault hooks cover the same writes.
{
    const journalKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournal.kt'), 'utf8');
    const shapes = Object.fromEntries([.../val SHAPES = mapOf\(([\s\S]*?)\n        \)\n/.exec(journalKt)[1].matchAll(/"(\w+)" to listOf\(([^)]*)\)/g)]
        .map(([, name, kinds]) => [name, [...kinds.matchAll(/"([^"]+)"/g)].map((m) => m[1])]));
    assert.match(journalKt, /val WRITES = SHAPES\.keys/);
    const writes = Object.keys(shapes).sort();
    const host = hostEntry.slice(hostEntry.indexOf('globalThis.MindwtrHost = {'));
    const methods = [...host.matchAll(/\n    (\w+)\([^)]*\): [^{\n]+\{([\s\S]*?)\n    \},/g)].map(([, name, body]) => ({ name, body }));
    assert(methods.length > 40 && methods.some((m) => m.name === 'menuCommand'), 'host-entry\'s methods parsed');
    // The iOS host's prepared commits and its Calendar preference, Focus grouping, Someday section task and task attachment
    // link/remove writes: its own journal holds them, and Kotlin never calls them.
    const iosPreparedCommits = ['captureCommit', 'draftCommit'];
    // The iOS host's task attachment link/remove methods (taskAttachmentLinks, taskAttachmentRemove) are its own; Kotlin sends
    // the same core writes through MENU_COMMANDS and the journal (pass A2).
    const iosOnlyWrites = ['commitPreparedNotificationSetting', 'commitReminderCompletion', 'retryReminderCompletion', 'commitReminderSnooze', 'retryReminderSnooze', 'setCalendarPreference', 'setFocusGroupChecked', 'commitPreparedSomedaySectionTask', 'submitAttachmentLinks', 'removeAttachment', 'setCalendarSetting'];
    // Core writes no host method calls yet (generic Calendar subscription Add):
    // wiring one into host-entry fails the write-list checks above until the journal takes it.
    const unwiredWrites = ['addCalendarFeed'];
    assert.equal(coreHost.match(new RegExp(`"(${iosPreparedCommits.join('|')})"`, 'g')), null, 'Kotlin never calls the iOS prepared commits');
    assert.deepEqual(methods.filter((m) => m.body.includes('taskResult(') && !iosPreparedCommits.includes(m.name)).map((m) => m.name).sort(), writes, 'the journal\'s write list is host-entry\'s task commands');
    const table = (name) => hostEntry.slice(hostEntry.indexOf(`const ${name}`), hostEntry.indexOf('\n};', hostEntry.indexOf(`const ${name}`)));
    const called = (text) => [...text.matchAll(/contract\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(called(hostEntry).filter((name) => unwiredWrites.includes(name)), [], 'no host method calls an unwired core write');
    const pushSetting = methods.find((method) => method.name === 'iosCalendarPushSetting');
    assert(pushSetting && pushSetting.body.includes('iosCalendarPushOwned('), 'Calendar push settings require the private iOS owner');
    assert.deepEqual(called(pushSetting.body), ['setCalendarSetting'], 'the private push facade delegates only its shared setting');
    const iosOnlyMethods = methods.filter((m) => called(m.body).some((name) => iosOnlyWrites.includes(name))).map((m) => m.name);
    {
        assert.equal(iosOnlyMethods.length, iosOnlyWrites.length, 'each iOS-only write has its host method');
        const java = resolve(app, 'android/app/src/main/java');
        const kotlin = readdirSync(java, { recursive: true }).filter((file) => file.endsWith('.kt')).map((file) => readFileSync(resolve(java, file), 'utf8')).join('\n');
        assert.equal(kotlin.match(new RegExp(`"(${iosOnlyMethods.join('|')})"`, 'g')), null, 'Kotlin never calls the iOS-only writes');
    }
    // Core's write commands: every command of the crash-safe table (native-request-receipts.ts states the rule each follows).
    const coreWrites = ['setTaskFocus', 'completeTask', 'setProjectFocus', 'createProject', 'saveSearch', 'updateTask', 'saveTaskDraft', 'resetTaskChecklist',
        'submitQuickCapture', 'submitQuickCaptureLines', 'submitQuickCapturePickerQuery', 'commitInboxProcessingStep', 'skipInboxProcessingTask', 'setAreaFilter',
        'activateProject', 'moveSomedayTasksToSection', 'undoSomedaySectionMove', 'addSomedaySectionTask', 'createSomedaySection', 'setTaskListSort',
        'runArchiveAction', 'runContextsAction', 'runTrashAction', 'runReviewAction', 'runCalendarAction', 'runBoardAction', 'runBulkAction', 'setFocusGroupBy',
        'saveFocusFilter', 'removeFocusFilterCriterion', 'deleteFocusFilter', 'reorderFocus', 'createBulkOrganizeDestination', 'addMindSweepItem', 'deleteSavedSearch',
        'setGeneralSetting', 'setGtdSetting', 'setDataSetting', 'saveManageEditor', 'deleteManageItem', 'renameSomedaySection', 'reorderSomedaySections', 'deleteSomedaySection',
        'submitCaptureModal', 'submitCaptureModalLines',
        // Settings › Sync: its option (a receipt of its own) and the screen's commands (never journaled: core keeps no payload of theirs).
        'setSyncPreference', 'openSyncSettings', 'closeSyncSettings', 'selectSyncBackend', 'saveSyncBackend', 'syncNow', 'testSyncConnection',
        'pickSyncFolder', 'connectDropbox', 'disconnectDropbox', 'runSyncEncryptionAction',
        // Settings › AI (pass C1): a control's change and the screen's open (receipts of their own), a key and a base URL (never journaled).
        'setAISetting', 'openAISettings', 'setAIKey', 'setAIEndpoint', 'ingestPendingCaptures',
        // Attachments (pass A2): Add file and Add photo, the link sheet's Save, Remove (a project's written at once, receipts of their own).
        'addAttachmentFile', 'submitAttachmentLinks', 'removeAttachment',
        // A reminder notification's Done and Snooze (pass R1), sent by CoreWork under the request UUID the notification was posted with.
        'completeReminderTask', 'snoozeReminder',
        // Project details: the user's edit (journaled ahead; core reads, prepares and commits it, a replay of an applied edit unchanged).
        'runProjectEdit'];
    const contractFiles = readdirSync(resolve(app, '../../packages/core/src')).filter((name) => /^native-host-contract[\w-]*\.ts$/.test(name) && !name.endsWith('.test.ts'))
        .map((name) => readFileSync(resolve(app, '../../packages/core/src', name), 'utf8'));
    const contractSource = contractFiles.join('\n');
    // A write takes its input (openSyncSettings and closeSyncSettings take none).
    for (const name of coreWrites) assert.match(contractSource, new RegExp(`\\b(async )?${name}\\((input|\\))`), `core defines the write ${name}`);
    const writeCalls = [...methods.filter((m) => writes.includes(m.name)).flatMap((m) => called(m.body)), ...called(table('MENU_COMMANDS'))];
    assert.deepEqual([...new Set(writeCalls)].sort(), [...coreWrites].sort(), 'the journaled methods call exactly core\'s write commands');
    // iOS's own write methods (taskAttachmentLinks, taskAttachmentRemove: core writes Kotlin journals as a project's, pass A2) are
    // left out by name: the check above proves no Kotlin file names them, and iOS journals them.
    const readCalls = [...methods.filter((m) => !writes.includes(m.name) && !iosOnlyMethods.includes(m.name)).flatMap((m) => called(m.body)),
        ...called(table('MENU_READS'))];
    assert.deepEqual(readCalls.filter((name) => coreWrites.includes(name)), [], 'no unjournaled host method calls a core write');
    // The AI's requests are reads too: they send task text to the provider and write nothing (an answer applies through the screen's edits).
    assert.deepEqual(called(table('AI_REQUESTS')).filter((name) => coreWrites.includes(name) || unwiredWrites.includes(name)), [], 'no AI request calls a core write');
    // An attachment's Download, Open and draft settlement are long calls too (CoreHost.attachmentRequest), never a journaled write.
    // A task draft's Add file, link Save and Remove write nothing (they answer the draft's next list), so they are never journaled
    // (a replay would copy a file no draft owns): they go here too, each refused for any owner but a task.
    const draftCommands = ['addAttachmentFile', 'submitAttachmentLinks', 'removeAttachment'];
    assert.deepEqual(called(table('ATTACHMENT_REQUESTS')).sort(), ['addAttachmentFile', 'downloadAttachment', 'openAttachment', 'removeAttachment',
        'settleTaskDraftAttachments', 'submitAttachmentLinks'], 'ATTACHMENT_REQUESTS are core\'s attachment downloads, opens, draft settlement and task draft commands');
    assert.deepEqual(called(table('ATTACHMENT_REQUESTS')).filter((name) => !draftCommands.includes(name) && (coreWrites.includes(name) || unwiredWrites.includes(name))), [],
        'no attachment request calls a core write but a task draft\'s');
    for (const name of draftCommands) {
        assert.match(table('ATTACHMENT_REQUESTS'), new RegExp(`\\n    \\w+: \\(input\\) => draftOnly\\(input, \\(\\) => contract\\.${name}\\(input\\)\\),`), `${name} runs unjournaled only for a task draft`);
    }
    assert.match(hostEntry, /const draftOnly = \(input: never, command: \(\) => Promise<Reply>\): Promise<Reply> => \(\(input as \{ owner\?: \{ kind\?: unknown \} \} \| null\)\?\.owner\?\.kind === 'task'\s*\? command\(\)\s*: Promise\.resolve\(\{ ok: false, error: \{ code: 'INVALID_INPUT', message: 'Only a task draft attachment command runs here' \} \}\)\);/);
    assert.match(source('Attachments.kt'), /if \(owner\.kind == "task"\) \{\s*sendDraft\(owner, kind,/, 'a task draft\'s commands take the draft path');
    assert.match(source('Attachments.kt'), /private fun sendDraft\([\s\S]{0,500}?runtime\.attachmentRequest\(DRAFT_REQUESTS\.getValue\(kind\)/, 'a task draft\'s commands are sent unjournaled');
    const attachmentEntry = /attachmentRequest\(name: string, json: string\): string \{([\s\S]*?)\n    \},/.exec(host)[1];
    assert.match(attachmentEntry, /return submit\(async \(\) => \{\s*requireSaved\(\);/);
    assert.match(attachmentEntry, /const request = ATTACHMENT_REQUESTS\[name\];/);
    assert(attachmentEntry.indexOf('requireSaved();') < attachmentEntry.indexOf('const request ='), 'attachment readiness precedes dispatch');
    assert.deepEqual(called(table('AI_REQUESTS')).sort(), ['loadAIModels', 'requestAICopilot', 'requestInboxClarify', 'requestTaskEditorBreakdown',
        'requestTaskEditorClarify', 'requestTaskEditorCopilot', 'requestWeeklyReviewAnalysis'], 'AI_REQUESTS are core\'s AI requests');
    assert.match(host, /aiRequest\(name: string, json: string\): string \{\s*return submit\(async \(signal\) => \{\s*requireSaved\(\);\s*const request = AI_REQUESTS\[name\];[\s\S]{0,120}?const answer = await request\(JSON\.parse\(json\) as never, signal\);\s*if \(signal\.aborted\) throw new Error\('The AI request was cancelled'\);\s*return unwrap\(answer\);/);
    // Each AI request hands the operation's signal to core (review C1 5).
    assert.equal(table('AI_REQUESTS').match(/\{ signal \}/g).length, 7, 'every AI request passes its signal');
    // Settings › AI (AISettings.kt) keeps a key and a base URL in memory only: no saved state, no saveable Compose state, no log
    // line with a typed value; a key or base URL goes only through its unjournaled command, never the Menu tab's send(). A consent
    // reset exists only behind the debug-only property.
    {
        const aiScreen = code(source('AISettings.kt'));
        assert.doesNotMatch(aiScreen, /saved\[|SavedStateHandle|rememberSaveable|keepDialog/, 'Settings › AI keeps nothing in saved state');
        assert.doesNotMatch(aiScreen, /Log\.\w\([^\n]*(typed|keys|text|next|value)\b/, 'Settings › AI logs no typed value');
        assert.match(aiScreen, /screenWrite\("setAIKey", /);
        assert.match(aiScreen, /screenWrite\("setAIEndpoint", /);
        assert.match(aiScreen, /fun set\(change: JSONObject, agreed: Boolean = false\) =\s+menu\.command\("setAISetting", /);
        const aiActions = code(source('AIActions.kt'));
        assert.doesNotMatch(aiActions, /menuCommand\(|rememberSaveable|saved\[/, 'the AI actions write nothing themselves and keep no saved state');
        assert.match(coreHost, /if \(debugFault\("ai_consent_reset"\) == "1"\) keyValue\.remove\("mindwtr-ai-provider-consent-v1"\)/);
    }
    // Core's AI device binds RN's stores (host-ai.ts): the refused secret calls (an AI key is no sync commit), RN's AsyncStorage.
    assert.match(hostEntry, /const nativeAI = nativeSync \? createNativeAI\(keyValue, \(\) => globalThis\.__mindwtrSecrets as HostSecrets, isFossBuild\) : null;/);
    assert.match(hostEntry, /const localAttachments = nativeSync \? null : createNativeLocalAttachmentsForHost\(\);/);
    assert.match(hostEntry, /const attachmentsHost = nativeSync\?\.attachmentsHost \?\? localAttachments\?\.contractHost;/);
    assert.match(hostEntry, /createNativeHostContract\(\{ reminderPlatform: globalThis\.__mindwtrHostPlatform === 'ios' \? 'ios' : 'android', get syncSettings\(\) \{ return nativeSync\?\.settingsHost \?\? iosManualSync\?\.settingsHost; \}, \.\.\.\(nativeAI \? \{ ai: nativeAI \} : \{\}\),\s*calendar: iosCalendar,\s*get attachments\(\) \{\s*const selected = iosProjectAttachmentDownload \? iosSelfHostedProjectAttachments\?\.contractHost \?\? iosManualSync\?\.attachmentsHost : attachmentsHost;\s*if \(!iosRelocatedProjectAvailability \|\| !selected\) return selected \?\? undefined;/);
    assert.match(hostEntry, /const result = await \(iosSelfHostedProjectAttachments \?\? iosManualSync\)\?\.prepareAttachmentAvailableDetailed\?\.\(attachment\);/);
    assert.match(host, /menuCommand\(name: string, json: string\): string \{\s*return submit\(async \(\) => \{\s*const command = MENU_COMMANDS\[name as MenuCommand\];/);
    // An entry replays only while it fits its write as host-entry takes it (WriteJournal.SHAPES): a JSON object for `json`, a
    // boolean for a boolean, a Menu command for menuCommand's name, text for the rest; MENU names exactly host-entry's
    // MENU_COMMANDS. One that does not fit is set aside intact, and the log names only its file.
    for (const [name, kinds] of Object.entries(shapes)) {
        const params = new RegExp(`\\n    ${name}\\(([^)]*)\\): string \\{`).exec(host)[1].split(',').map((param) => param.trim());
        assert.equal(kinds.length, params.length, `${name} takes ${params.length} arguments`);
        params.forEach((param, index) => {
            const kind = kinds[index];
            const fits = param.startsWith('json:') ? kind.startsWith('{') : /: boolean$/.test(param) ? kind === 'bool'
                : param.startsWith('name:') ? kind === 'menu' : ['id', 'text'].includes(kind);
            assert(fits, `${name}'s ${param} is journaled as ${kind}`);
        });
    }
    {
        const [pairs, shared] = /val MENU = mapOf\(([\s\S]*?)\) \+ listOf\(([\s\S]*?)\)\.associateWith/.exec(journalKt).slice(1);
        const menuNames = [...[...pairs.matchAll(/"(\w+)" to /g)].map((m) => m[1]), ...[...shared.matchAll(/"(\w+)"/g)].map((m) => m[1])].sort();
        assert.deepEqual(menuNames, [...table('MENU_COMMANDS').matchAll(/\n    (\w+): /g)].map((m) => m[1]).sort(), 'WriteJournal.MENU is host-entry\'s MENU_COMMANDS');
    }
    assert.match(journalKt, /if \(!fits\(method, args\) \|\| key\(method, args\) in UNJOURNALED\) return null/);
    assert.match(journalKt, /val moved = file\.renameTo\(target\)\s+log\(if \(moved\) "Native Android journal entry set aside \$\{file\.name\}" else "Native Android journal entry not moved aside \$\{file\.name\}"\)/);
    // SHAPES is only the first filter: a replay core refuses as malformed (INVALID_INPUT, an unknown Menu command too) moves
    // aside intact; a first send's refusal is dropped like any other.
    assert.match(journalKt, /fun malformed\(error: String\?\): Boolean = error\?\.startsWith\("INVALID_INPUT"\) == true/);
    assert.match(journalKt, /if \(replay && malformed\(error\)\) \{\s+if \(!moveAside\(entry\.file\)\) return false\s+\} else if \(!entry\.file\.delete\(\) && entry\.file\.exists\(\)\) \{/);
    // Never journaled: a write whose core command is in core's NATIVE_UNJOURNALED_COMMANDS (a payload that can carry a secret; the
    // names are receipt payloads' first elements). Each name leads, through the core write that builds that payload, to its journal
    // key (the host method, or a Menu command's name); WriteJournal.UNJOURNALED holds exactly those keys, and append skips them.
    {
        const receiptsTs = readFileSync(resolve(app, '../../packages/core/src/native-request-receipts.ts'), 'utf8');
        const set = /export const NATIVE_UNJOURNALED_COMMANDS: ReadonlySet<string> = new Set<string>\(([^)]*)\);/.exec(receiptsTs);
        assert(set, 'core\'s NATIVE_UNJOURNALED_COMMANDS parsed');
        const unjournaledCore = [...set[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
        const receiptNames = new Map([...coreWrites, ...iosOnlyWrites, ...unwiredWrites].map((name) => [name, []]));
        let sites = 0;
        for (const file of contractFiles) {
            const defs = [...file.matchAll(new RegExp(`\\n {8}(?:async )?(${[...coreWrites, ...iosOnlyWrites, ...unwiredWrites].join('|')})\\(input`, 'g'))];
            for (const site of file.matchAll(/JSON\.stringify\(\['(\w+)'/g)) {
                // App lock's tiny, non-sensitive payload is canonicalized in a shared helper
                // before both authorization and receipt lookup, outside the write body.
                if (site[1] === 'appLock' && file.includes('const payload = (request: AppLockRequest)')) {
                    assert.match(file, /const payload = \(request: AppLockRequest\): string => JSON\.stringify\(\['appLock', request\.value,/);
                    assert.match(file, /receipts\.run<AppLockResult>\(request\.requestId, key,/);
                    continue;
                }
                if (site[1] === 'notificationSetting' && file.includes('const payload = (request: NotificationSettingRequest)')) {
                    assert.match(file, /const payload = \(request: NotificationSettingRequest\) => JSON\.stringify\(\['notificationSetting', request\.edit\.type,/);
                    assert.match(file, /receipts\.run<NotificationSettingResult>\(request\.requestId, key,/);
                    assert.match(file, /async commitPreparedNotificationSetting\(input:/);
                    continue;
                }
                const completionHelper = 'const completionPayload = (request: ReminderCompletionRequest) => ';
                if (site[1] === 'reminderComplete' && file.includes(completionHelper)
                    && site.index === file.indexOf(completionHelper) + completionHelper.length) {
                    assert.match(file, /const completionPayload = \(request: ReminderCompletionRequest\) => JSON\.stringify\(\['reminderComplete', request\.taskId\]\);/);
                    assert.match(file, /methods\.completeReminderTask\(request\)/);
                    assert.match(file, /receipts\.saved<unknown>\(request\.requestId, completionPayload\(request\)\)/);
                    // The original writer's literal remains attributed below; this helper only probes or retries it.
                    continue;
                }
                const snoozeHelper = 'const snoozePayload = (request: ReminderSnoozeRequest) => ';
                if (site[1] === 'reminderSnooze' && file.includes(snoozeHelper)
                    && site.index === file.indexOf(snoozeHelper) + snoozeHelper.length) {
                    assert.match(file, /const snoozePayload = \(request: ReminderSnoozeRequest\) => JSON\.stringify\(\['reminderSnooze', request\.requestedAt, request\.details\]\);/);
                    assert.match(file, /methods\.snoozeReminder\(request\)/);
                    assert.match(file, /receipts\.saved<unknown>\(request\.requestId, snoozePayload\(request\)\)/);
                    // The legacy writer still owns its original payload; this helper only probes or retries it.
                    continue;
                }
                const owner = defs.filter((def) => def.index < site.index).at(-1);
                assert(owner, `core's receipt payload '${site[1]}' sits inside a core write`);
                receiptNames.get(owner[1]).push(site[1]);
                if (coreWrites.includes(owner[1])) sites += 1;
            }
        }
        assert(sites >= 26, 'core\'s receipt payloads parsed');
        // A name is a receipt payload's, or a core write that keeps no payload at all (Settings › Sync's screen commands).
        for (const name of unjournaledCore) assert([...receiptNames.values()].flat().includes(name) || receiptNames.get(name)?.length === 0, `core's unjournaled ${name} is a core write's receipt payload, or a payload-less core write`);
        const menuKeys = [...table('MENU_COMMANDS').matchAll(/\n    (\w+): \((input)?\) => contract\.(\w+)\(\2\),/g)].map(([, key, , write]) => ({ key, writes: [write] }));
        assert.equal(menuKeys.length, table('MENU_COMMANDS').match(/\n    \w+: /g).length, 'every Menu command parsed');
        const keys = [...methods.filter((m) => writes.includes(m.name) && m.name !== 'menuCommand').map((m) => ({ key: m.name, writes: called(m.body) })), ...menuKeys];
        const expected = keys.filter((key) => key.writes.some((write) => unjournaledCore.includes(write) || receiptNames.get(write).some((name) => unjournaledCore.includes(name))))
            .map((key) => key.key).sort();
        const kotlin = /val UNJOURNALED = (?:emptySet<String>\(\)|setOf\(([^)]*)\))\n/.exec(journalKt);
        assert(kotlin, 'WriteJournal.UNJOURNALED parsed');
        assert.deepEqual([...(kotlin[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), expected, 'WriteJournal.UNJOURNALED is core\'s NATIVE_UNJOURNALED_COMMANDS by journal key');
        assert.match(journalKt, /require\(method in WRITES\) \{ "\$method is not a write" \}\s+if \(key\(method, args\) in UNJOURNALED\) return null/);
        assert.match(journalKt, /\n        fun key\(method: String, args: List<Any\?>\): Any\? = if \(method == "menuCommand"\) args\.firstOrNull\(\) else method/);
        // The long call path (CoreHost.callLong: Settings › Sync's commands and the AI's requests, which never hold the engine) takes
        // only an unjournaled write or a read, so no journaled write can skip the journal through it.
        assert.match(journalKt, /fun unjournaled\(method: String, args: List<Any\?>\): Boolean = method in WRITES && key\(method, args\) in UNJOURNALED/);
        assert.match(coreHost, /private fun callLong\(method: String, vararg args: Any\?, handle: LongCall = LongCall\(\)\): JSONObject \{\s+require\(method !in WriteJournal\.WRITES \|\| WriteJournal\.unjournaled\(method, args\.toList\(\)\)\)/);
        assert.deepEqual([...coreHost.matchAll(/\bcallLong\("(\w+)"/g)].map((m) => m[1]), ['backgroundSync', 'menuCommand', 'aiRequest', 'attachmentRequest'],
            'only CoreWork\'s background sync run, Settings › Sync\'s commands, the AI\'s requests and the attachments\' downloads take the long path');
        // S4a: CoreWork's background run (core's runner) is a read-and-sync like Sync now: no journaled write.
        assert.match(coreHost, /fun backgroundSync\(trigger: String, stored: Int\): JSONObject =\s+callLong\("backgroundSync", trigger, stored, debugFault\("bgsync_deadline_ms"\)\.toIntOrNull\(\) \?: 0\)/);
        assert(!writes.includes('backgroundSync'), 'a background sync run is no journaled write');
        assert.match(coreHost, /fun attachmentRequest\(name: String, json: String\): JSONObject = callLong\("attachmentRequest", name, json\)/);
        assert(!writes.includes('attachmentRequest'), 'an attachment request is no journaled write');
        assert.match(coreHost, /fun syncCommand\(name: String, json: String\): JSONObject = callLong\("menuCommand", name, json\)/);
        assert.match(coreHost, /fun aiRequest\(name: String, json: String, handle: LongCall = LongCall\(\)\): JSONObject = callLong\("aiRequest", name, json, handle = handle\)/);
        // Review C1 5: a cancelled or timed-out AI request aborts its JS operation (the provider's fetch) through the host's abort.
        assert.match(coreHost, /fun cancel\(handle: LongCall\) \{[\s\S]{0,400}?abortLong\(handle\)/);
        assert.match(coreHost, /private fun abortLong\(handle: LongCall\) \{[\s\S]{0,200}?call\("abort", id\)/);
        assert(!writes.includes('aiRequest'), 'an AI request is no journaled write');
        // The Kotlin screens' unjournaled commands are the unjournaled set: Settings › Sync's, and Settings › AI's key and base URL.
        const syncCommands = [.../val SYNC_COMMANDS = setOf\(([^)]*)\)/.exec(source('SyncSettings.kt'))[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
        const aiCommands = [.../val AI_COMMANDS = setOf\(([^)]*)\)/.exec(source('AISettings.kt'))[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
        assert.deepEqual([...syncCommands, ...aiCommands.filter((name) => name !== 'openAISettings')].sort(), [...(kotlin[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(),
            'SYNC_COMMANDS and AI_COMMANDS (but its journaled open) are WriteJournal.UNJOURNALED');
        // Review S3 4: each backend choice goes, in tap order; only the same choice still pending is dropped.
        assert.match(source('SyncSettings.kt'), /run\("selectSyncBackend", [^\n]*key = "selectSyncBackend:\$option", ordered = choices\)/);
        assert.match(source('SyncSettings.kt'), /if \(!light && !inFlight\.add\(key\)\) return/);
        // S4b: an encryption submit or decline runs with the passphrase fields core holds, so it starts only after every keystroke
        // sent before it (the light queue); light actions (Show passphrase) keep answering while it runs.
        assert.match(source('SyncSettings.kt'), /run\("runSyncEncryptionAction", input, light = !heavy, after = if \(heavy\) SyncSettingsModel\.light else null,\s+admit = if \(type == "submit"\) \(\{ passphrases\.admit\(action\) \}\) else null\)/);
        assert.match(source('SyncSettings.kt'), /val result = runCatching \{\s+after\?\.submit \{\}\?\.get\(\)\s+admit\?\.let \{ check -> onMain\(check\)\?\.let \{ refusal -> throw IllegalStateException\("PASSPHRASE_REFUSED: \$refusal"\) \} \}\s+runtime\.syncCommand\(name, input\.toString\(\)\)/);
        // Review S4b 1 (and its verification): a passphrase field never holds more than core takes (the row's maxLength), an edit
        // core's `typed` command refused stands refused, and either blocks the submit instead of running it with the older text
        // core kept, at the tap and again once the keystrokes before it settled. A flow change (open, cancel, retry) drops the
        // refusals, and Abandon setup is never blocked (PassphraseFieldsTest).
        assert.match(source('SyncSettings.kt'), /passphrases\.admit\(action\)\?\.let \{ refusal -> shell\.showToast\(null, refusal, "error"\); return \}/);
        assert.match(source('SyncSettings.kt'), /sync\.typePassphrase\(field, text, row\.getInt\("maxLength"\), row\.getString\("tooLong"\)\)/);
        assert.match(source('SyncSettings.kt'), /val edit = passphrases\.type\(field, text, maxLength, tooLongText\) \?: return shell\.showToast\(null, tooLongText, "error"\)/);
        assert.match(source('SyncSettings.kt'), /failed = \{ message -> passphrases\.settled\(field, edit, message\) \}\) \{ passphrases\.settled\(field, edit, null\) \}/);
        assert.match(source('SyncSettings.kt'), /failed\(message\.substringAfter\(": "\)\)/);
    }
    // Sync's engine work between host calls: a host-call answer wakes the idle pump, and the next timer schedules it; neither
    // runs after the host stopped or closed.
    assert.match(coreHost, /io\.wake = \{ runCatching \{ executor\.execute \{ idlePump\(\) \} \} \}/);
    assert.match(coreHost, /private fun idlePump\(\) \{[\s\S]*?val engine = context \?: return\s+if \(stopped != null\) return/);
    assert.match(coreHost, /pumpTask = executor\.schedule\(\{ idlePump\(\) \}, delay, TimeUnit\.MILLISECONDS\)/);
    assert.match(coreHost, /executeExistingDelayedTasksAfterShutdownPolicy = false/);
    // The network state as RN's expo-network reads it (Android 10+): reachable is an active network, connected a known transport.
    {
        const expoNetwork = readFileSync(resolve(app, '../../node_modules/expo-network/android/src/main/java/expo/modules/network/NetworkModule.kt'), 'utf8');
        const hostNetwork = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostNetwork.kt'), 'utf8');
        assert.match(expoNetwork, /val isInternetReachable = network != null/);
        assert.match(hostNetwork, /put\("isInternetReachable", network != null\)/);
        const transports = (text) => [...new Set([...text.matchAll(/TRANSPORT_(\w+)/g)].map((m) => m[1]))].sort();
        assert.deepEqual(transports(hostNetwork), transports(expoNetwork), 'HostNetwork counts expo-network\'s transports as connected');
        assert.match(hostNetwork, /override fun onAvailable\(network: Network\) = report\(\)\s+override fun onLost\(network: Network\) = report\(\)/);
        assert.match(readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8'), /android\.permission\.ACCESS_NETWORK_STATE/);
    }

    // callAsync journals before the engine call and settles after the reply; answer() is the only engine call, used by callAsync
    // and the replay; nothing else calls a host method.
    const callAsyncFn = coreHost.slice(coreHost.indexOf('private fun callAsync('), coreHost.indexOf('private fun answer('));
    assert.match(callAsyncFn, /val entry = if \(method in WriteJournal\.WRITES\) checkNotNull\(journal\)\.append\(method, args\.toList\(\)\) else null[\s\S]*?val result = answer\(method, args, deadlineMs\)\s+if \(entry != null\) \{\s+debugDelay\("delay_after_ms"\)\s+journalStop\(stop, "after", entry\)\s+\}\s+if \(method in WriteJournal\.WRITES\) settle\(entry, result, replay = false\)/);
    assert.match(callAsyncFn, /if \(entry != null\) \{\s+checkNotNull\(sqlite\)\.failCommits = debugFault\("fail_commit"\) == "1"\s+debugDelay\("delay_before_ms"\)\s+journalStop\(stop, "before", entry\)\s+\}/);
    assert.equal(coreHost.match(/\banswer\(/g).length, 3, 'answer(): its definition, callAsync and replayJournal');
    assert.equal(coreHost.match(/\bcall\(method, \*args\)/g).length, 2, 'answer() and callLong (an unjournaled command only) start host methods');
    assert.deepEqual([...new Set([...coreHost.matchAll(/\bcall\("(\w+)"/g)].map((m) => m[1]))].sort(), ['abort', 'cancel', 'poll'], 'the engine\'s own calls: abort (a long call no longer wanted), cancel and poll');
    assert.equal(coreHost.match(/journalStop\(stop, /g).length, 2, 'the stop hooks run for a first send only, never for a replay');
    assert.match(coreHost, /val stop = if \(entry != null\) debugFault\("journal_stop"\) else ""/, 'the stop hook is debug-only');
    // Drop and keep: SAVE_FAILED keeps an entry, every other reply drops it; no reply (a throw) leaves it.
    assert.match(journalKt, /fun keeps\(error: String\?\): Boolean = error\?\.startsWith\("SAVE_FAILED"\) == true/);
    // An entry leaves (in memory too) only after its delete and the folder sync; a failed one stays for the next boot.
    assert.match(journalKt, /fun settle\(entry: Entry, error: String\?, replay: Boolean = false\): Boolean \{\s+if \(keeps\(error\)\) return false\s+if \(replay && malformed\(error\)\) \{[\s\S]*?\} else if \(!entry\.file\.delete\(\) && entry\.file\.exists\(\)\) \{\s+log\([^\n]*\)\s+return false\s+\}\s+try \{\s+syncDirectory\(dir\)\s+\} catch \(failure: Exception\) \{\s+log\([^\n]*\)\s+return false\s+\}\s+entries\.remove\(entry\)\s+return true/);
    assert.match(journalKt, /entries\.firstOrNull \{ it\.text == text \}\?\.let \{ return it \}/, 'an owed retry reuses its entry');
    assert.match(journalKt, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(text\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)[\s\S]*?syncDirectory\(dir\)\s+return Entry/);
    // Replay: in journal order, one at a time, stopped by a kept entry or no reply; at boot after the validated load and the
    // language, before this boot hands the host to any screen (get() waits on the boot); a stop is the screens' owed retry.
    const replayFn = coreHost.slice(coreHost.indexOf('fun replayJournal()'), coreHost.indexOf('private fun journalStop('));
    assert.match(replayFn, /for \(entry in journal\.pending\(\)\) \{[\s\S]*?answer\(entry\.method, entry\.args\.toTypedArray\(\), deadlineOf\(entry\.method, entry\.args\)\)\.also \{ if \(settle\(entry, it, replay = true\)\) dropped \+= 1 \}\.error\(\)\s+\} catch \(failure: Throwable\) \{\s+owed = [^\n]+\s+break\s+\}\s+if \(WriteJournal\.keeps\(error\)\) \{ owed = error; break \}/);
    assert.match(replayFn, /Log\.i\(TAG, "Native Android journal replay sent=/);
    assert(coreHost.indexOf('journal = WriteJournal(journalDir') < coreHost.indexOf('engine.evaluate(bundle'));
    assert.match(owner, /private fun replay\(runtime: CoreHost\): Boolean \{\s+val replay = runtime\.replayJournal\(\)\s+replay\.owed\?\.let \{ recordFailure\(PendingFailure\(FailedAction\("journal", ""\), it, null\)\); return false \}\s+(?:\/\/[^\n]*\s+)+if \(replay\.left > 0\) return true\s+runCatching \{ runtime\.pruneReceipts\(\) \}[\s\S]*?return true\s+\}/);
    // Sync (plan block 1): its triggers start only after the validated load, a replay that finished (no entry owed) and the queue
    // drain (ProcessCoreHost.recovered), or once the owed journal retry went through; nothing else starts them.
    assert.match(owner, /loadTheme\(runtime, legacy\?\.theme\)\s+(?:\/\/[^\n]*\s+)*recoverInstalls\(installer\)\s+if \(replay\(runtime\)\) recovered\(app, runtime, deferSync = true\)\s+(?:\/\/[^\n]*\s+)*deferredWidgets\.hold\(runtime\)\s+return runtime/);
    assert.equal([activity, model, owner, menuModel].join('\n').match(/syncStart\(/g).length, 1, 'one start of the triggers, in startSync');
    assert.equal([activity, model, owner, menuModel].join('\n').match(/startSync\(app, runtime\)/g).length, 3, 'startSync only in recovered, after the drain (held for the first screen\'s content, or CoreWork\'s through startSyncWithScreen)');
    // Startup follow-up: the boot's start is held until the first screen shows its content: the Inbox's first rows (contentShown),
    // another tab's boot read, or a 3 s fallback; CoreWork's and the owed retry's start at once. One start at a time.
    // The reminder alarms start with sync (pass R1), held with it.
    assert.match(owner, /startSync = \{\s+if \(deferSync\) deferredSync\.set \{\s+startSync\(app, runtime\)\s+startReminders\(runtime\)\s+\} else \{\s+startSyncWithScreen\(app, runtime\)\s+startReminders\(runtime\)\s+\}\s+\},/);
    assert.match(owner, /fun startDeferredSync\(trigger: String = "content"\) \{\s+synchronized\(deferredSync\) \{\s+screenShown = true\s+deferredSync\.getAndSet\(null\)\s+\}\?\.let \{ start -> syncThread\.execute \{ start\(\) \} \}\s+deferredWidgets\.take\(\)\?\.let \{ publishHeldWidgets\(it, trigger\) \}\s+\}/, 'the boot\'s widget publication waits with its sync start');
    // S4a: a process no screen showed in (a CoreWork job's) starts no triggers: as RN's headless runs, it syncs only through core's
    // background run, which the job awaits. Once a screen showed, CoreWork's recovery starts them at once.
    assert.match(owner, /private fun startSyncWithScreen\(app: Application, runtime: CoreHost\) \{\s+val now = synchronized\(deferredSync\) \{\s+(?:\/\/[^\n]*\s+)*if \(!screenShown\) deferredSync\.compareAndSet\(null\) \{ startSync\(app, runtime\) \}\s+screenShown\s+\}\s+if \(now\) startSync\(app, runtime\)\s+\}/);
    assert.match(owner, /fun contentShown\(\) \{\s+startDeferredSync\(\)/);
    assert.match(owner, /private fun startSync\(app: Application, runtime: CoreHost\): Unit = synchronized\(syncLock\) \{\s+if \(syncHost != null\) return/);
    assert.match(model, /if \(screen != Screen\.Inbox\) ProcessCoreHost\.startDeferredSync\(\)\s+main\.postDelayed\(\{ ProcessCoreHost\.startDeferredSync\("boot-timeout"\) \}, SYNC_FALLBACK_MS\)/);
    assert.equal([activity, model, owner, menuModel].join('\n').match(/recovered\(app, runtime(?:, deferSync = true)?\)|ProcessCoreHost\.recovered\(getApplication\(\), runtime\)/g).length, 2, 'recovered after the boot replay and the owed retry (CoreWork\'s is checked with the runner)');
    // Core's receipts are pruned once per boot, and only after a replay that left nothing: never before the replay, never while an
    // entry that may need its receipt is left.
    assert.match(coreHost, /fun pruneReceipts\(\): JSONObject = callAsync\("pruneReceipts"\)/);
    assert.equal([activity, model, owner, menuModel].join('\n').match(/pruneReceipts\(\)/g).length, 1, 'one prune call, after the boot replay');
    assert.equal(owner.match(/replay\(runtime\)|replayJournal\(\)/g).length, 3, 'the boot\'s replay, and CoreWork\'s recovery');
    assert.match(model, /"journal" -> perform\(action\) \{ runtime ->\s+runtime\.replayJournal\(\)\.owed\?\.let \{ throw IllegalStateException\(it\) \}\s+acknowledged\(action\)\s+\/\/[^\n]*\s+if \(!ProcessCoreHost\.recovered\(getApplication\(\), runtime\)\) throw IllegalStateException\(ProcessCoreHost\.failure\?\.error \?: "SAVE_FAILED"\)\s+\}/);
    assert.equal([activity, model, owner, menuModel].join('\n').match(/replayJournal\(\)/g).length, 3, 'the boot, the owed retry and CoreWork\'s recovery replay; nothing else');
    // The JVM tests keep the file rules (order, the atomic write, drop and keep, move-aside, writes only).
    const journalTest = readFileSync(resolve(app, 'android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournalTest.kt'), 'utf8');
    for (const name of ['entriesKeepTheirOrderAcrossAReopen', 'anEntryIsDurableBeforeAppendReturns', 'aWriteCutShortIsNeverAnEntry', 'anyFinalReplyDropsTheEntry',
        'saveFailedKeepsTheEntryAndItsRetryReusesIt', 'damagedOrUnknownEntriesMoveAsideAndAreNeverReplayed', 'onlyWriteMethodsAreJournaled', 'onlySaveFailedKeeps',
        'aJournalThatCannotBeListedRefusesToOpen', 'anAppendNeverReplacesAnEntryOnDisk', 'theSequenceResumesAfterTheHighestNameSeen',
        'aDropIsDurableBeforeTheEntryLeaves', 'aDeleteThatFailsKeepsTheEntry', 'aDropWhoseFolderSyncFailsKeepsTheEntry', 'entriesThatNoLongerFitAWriteMoveAsideIntact',
        'aReplayCoreRefusesAsMalformedMovesAsideIntact']) {
        assert.match(journalTest, new RegExp(`@Test fun ${name}\\(\\)`));
    }
}

// The editor reads core's model (getTaskEditorModel, getTaskView's saved checklist and attachments, and editTaskChecklist's field)
// and saves only through core's saveTaskDraft (draft fields and checklist in one write), via perform with an exact FailedAction.
// The status menu keeps updateTask.
assert.match(coreHost, /fun taskEditorModel\(id: String\): JSONObject = callAsync\("editorModel", id\)/);
assert.match(coreHost, /fun taskView\(json: String\): JSONObject = callAsync\("taskView", json\)/);
assert.match(coreHost, /fun editTaskChecklist\(id: String, draftJson: String, checklistJson: String, editJson: String\): JSONObject =\s*callAsync\("editChecklist"/);
assert.match(coreHost, /fun resetTaskChecklist\(id: String, requestId: String, taskRevision: String\): JSONObject =\s*callAsync\("resetChecklist", JSONObject\(\)\.put\("id", id\)\.put\("requestId", requestId\)\.put\("taskRevision", taskRevision\)\.toString\(\)\)/);
assert.match(coreHost, /fun editorSuggestions\(id: String, field: String, query: String, limit: Int\): JSONObject =\s*callAsync\("editorSuggestions", id, field, query, limit\)/);
assert.match(coreHost, /fun saveTaskDraft\(id: String, baseJson: String, patchJson: String, checklistJson: String, attachmentsJson: String, requestId: String\): JSONObject =\s*callAsync\("saveDraft", JSONObject\(\)\.put\("id", id\)\.put\("base", JSONObject\(baseJson\)\)\.put\("patch", JSONObject\(patchJson\)\)\s*\.apply \{ if \(checklistJson\.isNotEmpty\(\)\) put\("checklist", JSONObject\(checklistJson\)\) \}\s*\.apply \{ if \(attachmentsJson\.isNotEmpty\(\)\) put\("attachments", JSONObject\(attachmentsJson\)\) \}\.put\("requestId", requestId\)\.toString\(\)\)/);
assert.match(coreHost, /fun updateTask\(id: String, baseJson: String, patchJson: String, requestId: String\): JSONObject =\s*callAsync\("update", JSONObject\(\)\.put\("id", id\)\.put\("base", JSONObject\(baseJson\)\)\.put\("patch", JSONObject\(patchJson\)\)\s*\.put\("requestId", requestId\)\.toString\(\)\)/);
assert.doesNotMatch(coreHost + hostEntry, /taskEditor\(|getTaskEditor\(/, 'the seven-field editor reply is gone');
assert.match(hostEntry, /editorModel\(id: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getTaskEditorModel\(\{ id \}\)\);/);
// taskView parses through editorJson (shared with the iOS attachment edits): JSON.parse under a size bound, and a refusal
// that never quotes the request.
assert.match(hostEntry, /taskView\(json: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getTaskView\(editorJson\(json\) as Parameters<typeof contract\.getTaskView>\[0\]\)\);/);
assert.match(hostEntry, /const editorJson = \(json: string\): unknown => \{\s*try \{ if \(json\.length <= 2_000_000\) return JSON\.parse\(json\); \}\s*catch \{ \/\*[^*]*\*\/ \}\s*throw new Error\('Invalid bounded editor request'\);\s*\};/);
assert.match(hostEntry, /editChecklist\(json: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.editTaskChecklist\(JSON\.parse\(json\)\)\);/);
assert.match(hostEntry, /resetChecklist\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('resetChecklist', await contract\.resetTaskChecklist\(JSON\.parse\(json\)\)\)\);/);
assert.match(hostEntry, /editorSuggestions\(id: string, field: string, query: string, limit: number\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getTaskEditorSuggestions\(\{ id, field: [^,]*, query, limit \}\)\);/);
assert.match(hostEntry, /saveDraft\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('saveTaskDraft', await contract\.saveTaskDraft\(JSON\.parse\(json\)\)\)\);/);
assert.match(hostEntry, /update\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('update', await contract\.updateTask\(JSON\.parse\(json\)\)\)\);/);
assert.equal(model.match(/runtime\.taskEditorModel\(id\)/g).length, 1, 'readEditor: open and Reload');
assert.match(model, /val model = runtime\.taskEditorModel\(id\)\s+val view = runtime\.taskView\(JSONObject\(\)\.put\("id", id\)\.toString\(\)\)[\s\S]{0,300}?return EditorModel\.of\(model, view, field\)/);
assert.equal(model.match(/readEditor\(runtime, id\)/g).length, 2, 'open and Reload');
assert.equal(model.match(/runtime\.saveTaskDraft\(/g).length, 1, 'the editor save');
assert.equal(model.match(/runtime\.updateTask\(/g).length, 1, 'the status menu and the Restore and Next swipes');
assert.equal(model.match(/runtime\.editorSuggestions\(/g).length, 1);
assert.equal([activity, owner, editorUi].join('\n').match(/taskEditorModel\(|taskView\(|editTaskChecklist\(|resetTaskChecklist\(|editorSuggestions\(|saveTaskDraft\(|updateTask\(/g), null);
assert.equal([activity, editorUi, focusUi, projectsUi, rowUi, areaUi, viewStateKt, searchUi, processUi, captureUi, captureModalUi, ...Object.values(menuScreens)].join('\n').replace(/^import .*$/gm, '').match(/CoreHost|callAsync|\bruntime\b/g), null);
// The save: exactly the changed draft fields, base = their loaded values, as a perform with its exact FailedAction; no change means no call.
assert.match(editorUi, /val patch: Map<String, String\?> get\(\) = edited\.filter \{ \(field, literal\) -> literal != base\(field\) \}/);
assert.match(editorUi, /val base: Map<String, String\?> get\(\) = patch\.keys\.associateWith \{ base\(it\) \}/);
assert.match(model, /fun saveDraftAction\(current: TaskEditor\) =\s+withRequestId\(FailedAction\("saveDraft", current\.id, current\.checklistSave, base = current\.base, patch = current\.patch,\s+attachments = current\.attachmentsSave\), failedAction\)/);
// An update and an editor save carry a request UUID (core's receipt answers a repeat with the first reply); the same command while
// it is owed is the owed request itself, so its control sends the exact retry. Kotlin never derives a request UUID from the request.
assert.match(model, /private fun withRequestId\(action: FailedAction, owed: FailedAction\?\) =\s+owed\?\.takeIf \{ it\.copy\(requestId = ""\) == action \} \?: action\.copy\(requestId = UUID\.randomUUID\(\)\.toString\(\)\)/);
assert.match(model, /fun statusAction\(task: TaskRow, status: String\) =\s+withRequestId\(FailedAction\("update", task\.id, base = mapOf\("status" to task\.status\), patch = mapOf\("status" to status\)\), failedAction\)/);
assert.match(model, /val current = editor \?: return\s+if \(current\.waiting \|\| editsPending\) \{ saveQueued = true; return \}\s+if \(current\.patch\.isEmpty\(\) && !current\.checklistChanged && !current\.attachmentsChanged\) \{ closeEditor\(\); return \}/);
// The attachments ride the same save (pass A2): the list the draft started from and the edited one, sent only when changed.
assert.match(editorUi, /val attachmentsSave: String get\(\) = if \(!attachmentsChanged\) "" else\s+JSONObject\(\)\.put\("base", JSONArray\(attachmentsFrom \?: model\.attachmentsBase\)\)\.put\("value", JSONArray\(attachmentsNow\)\)\.toString\(\)/);
assert.match(editorUi, /val attachmentsBase: String = content\.optJSONArray\("attachmentsBase"\)\?\.toString\(\) \?: "\[\]"/);
// The checklist rides the same save: its base is the checklist the editor loaded (getTaskView's checklistBase), sent only when changed.
assert.match(editorUi, /val checklistSave: String get\(\) = if \(!checklistChanged\) "" else JSONObject\(\)\.put\("base", JSONArray\(model\.checklistBase\)\)\.put\("value", JSONArray\(checklistNow\)\)\.toString\(\)/);
assert.match(editorUi, /val checklistBase: String = content\.getJSONArray\("checklistBase"\)\.toString\(\)/);
assert.match(model, /private fun sendDraft\(action: FailedAction\) = perform\(action\) \{ runtime ->\s+try \{\s+runtime\.saveTaskDraft\(action\.id, draftJson\(action\.base\), draftJson\(action\.patch\), action\.title, action\.attachments, action\.requestId\)/);
// Draft values are core's own JSON, compared and sent as JSON text; null stays JSON null.
assert.match(editorUi, /fun draftJson\(values: Map<String, String\?>\): String =\s*JSONObject\(\)\.apply \{ values\.forEach \{ \(field, literal\) -> put\(field, draftValue\(literal\)\) \} \}\.toString\(\)/);
// Typed token and person text becomes core's draft value (getTaskEditorSuggestions), applied only while the text is unchanged; Save waits for it.
assert.match(editorUi, /if \(field !in inputs \|\| input\(field\) != text\) this\s+else withEdits\(mapOf\(field to draftLiteral\(draftValue\)\)\)\.copy\(resolved = resolved \+ \(field to text\)\)/);
assert.match(model, /val resolved = current\.resolve\(field, text, found\.draftValue\)\s+keepEditor\(resolved\)/);
assert.match(editorUi, /val saveEnabled = if \(editor\.readOnly\) true else writable && !busy &&\s*\(failedAction == null \|\| failedAction == saveDraftAction\(editor\)\)/);
// Suggestions are a background read: they never take busy and never replace an owed retry.
assert.match(model, /background\(listOf\(Part\.Editor\), \{ runtime -> EditorSuggestions\.parse\(text, runtime\.editorSuggestions\(id, coreField, text, SUGGESTIONS\)\) \}\)/);
// Reload after a conflict: an edit survives only where the stored value still equals the old base.
assert.match(editorUi, /val kept = \{ field: String -> \(fresh\.draft\[field\] \?: "null"\) == base\(field\) \}/);
// Kotlin holds no editor rule: the fields, their order, sections, open state, badges, and choices are core's model, walked as sent.
assert.match(editorUi, /for \(section in editor\.view\.sections\) \{/);
// Every structural edit goes through core's editTaskDraft, one at a time, and the editor shows the model core returns.
assert.match(coreHost, /fun editTaskDraft\(id: String, draftJson: String, editJson: String, checklistJson: String = ""\): JSONObject =\s*callAsync\("editDraft"[\s\S]{0,300}?put\("checklist", JSONArray\(checklistJson\)\)/);
// The layout follows the editor's own checklist (unsaved items included), as RN's: every step sends it.
assert.match(model, /if \(queued == null\) edit else "", list\)/);
assert.match(hostEntry, /editDraft\(json: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.editTaskDraft\(JSON\.parse\(json\)\)\);/);
assert.match(model, /background\(listOf\(Part\.Editor\), \{ engine -> runCatching \{ stepEditor\(engine, current, sent, next\.edit\) \} \}\)/);
// A checklist edit is queued with the draft's edits: core's editTaskChecklist first (a list task's status follows its items), then
// core's model for the draft, and core's checklist field for it. Kotlin never edits a checklist item itself.
assert.match(model, /val checked = listEdit\?\.let \{ engine\.editTaskChecklist\(current\.id, draftJson\(sent\), current\.checklistNow, it\.toString\(\)\) \}/);
assert.match(model, /val model = engine\.editTaskDraft\(current\.id, checked\?\.getJSONObject\("draft"\)\?\.toString\(\) \?: draftJson\(sent\), if \(queued == null\) edit else "", list\)/, 'a dropped checklist edit only reads the view');
assert.match(model, /fun editChecklist\(edit: JSONObject, field: String\? = null\) = editDraft\(JSONObject\(\)\.put\("checklist", edit\), field\)/);
assert.match(model, /if \(inFlight != null \|\| current == null \|\| runtime == null \|\| busy \|\| failedAction != null\) return/);
// Generation and sequence: a reply counts only for its own editor session and the edit it answers, still first in the
// queue; open, restore and Reload start a new session, and Close drops the in-flight ticket.
assert.match(model, /val ticket = current\.session to next\.seq/);
assert.match(model, /val now = editor\?\.takeIf \{ it\.session == ticket\.first && it\.pending\.firstOrNull\(\)\?\.seq == ticket\.second \}/);
assert.match(editorUi, /val session: String = UUID\.randomUUID\(\)\.toString\(\)/);
assert.match(model, /fun closeEditor\(settle: Boolean = true\) \{[\s\S]{0,600}?attachments\.closed\(\)\s+ai\.cancelEditor\(\)\s+inFlight = null/);
// A Discard settles the draft's attachments (core's settleTaskDraftAttachments, pass A2): baseline and committed are the list the
// draft started from, at the revision the editor read; a Save settles its own after it landed (closeEditor(settle = false)).
assert.match(model, /attachments\.settle\(closing\.id, closing\.model\.taskRevision, from, closing\.attachmentsNow, from\)/);
// A close while a save is owed (a View-tab link) never settles: that save's own settlement runs when it lands (review 2; the
// rule itself is DraftAttachmentsTest's).
assert.match(model, /editor\?\.takeIf \{ discardSettles\(settle, pendingSave != null, it\.attachments != null, it\.readOnly\) \}\?\.let \{ closing ->/);
// Pending edits are in the draft file before dispatch; each reply's draft and the removal of its edit are one write;
// a restore sends them again in order.
assert.match(model, /keepEditor\(current\.queued\(edit\.toString\(\), field\)\)\s+pumpEdits\(\)/);
assert.match(model, /keepEditor\(now\.viewed\(step\.view, sent\)\.copy\(pending = now\.pending\.drop\(1\), checklist = step\.checklist \?: now\.checklist\)\)/);
assert.match(editorUi, /\.put\("edits", JSONArray\(\)\.apply \{ pending\.forEach/);
assert.match(editorUi, /val edits = saved\.optJSONArray\("edits"\)/);
assert.match(model, /restored\?\.let \{ resumeEditor\(it, savedDraft\.optJSONObject\("pending"\)\) \}\s+\/\/[^\n]*\s+pumpEdits\(\)/);
// A refused edit cancels a queued Save and keeps core's message; typed text keeps newer typing; Reload waits for the queue.
assert.match(model, /error = editRefusal\s+saveQueued = false/);
assert.match(editorUi, /LaunchedEffect\(coreValue\) \{ if \(!pending\) text = coreValue \}/);
assert.match(editorUi, /enabled = !busy && !failed && !editsPending\) \{ Text\(t\("common\.retry"\)\) \}/);
assert.match(model, /\.put\("amount", amount \?: latest\?\.get\("amount"\) \?: shown\.getInt\("amount"\)\)/);
assert.match(model, /fun editFields\(values: Map<String, Any\?>\) =\s*editDraft\(JSONObject\(\)\.put\("type", "fields"\)/);
assert.match(editorUi, /if \(\(current\[field\] \?: "null"\) != \(sent\[field\] \?: "null"\)\) current\[field\] \?: "null" else reply\.draft\[field\] \?: "null"/);
// Dates: core's label, core's picker starts, core's date edits; Kotlin never writes a date value of its own.
assert.match(editorUi, /DateButton\(part\.label, label, !locked, Modifier\.weight\(1f\)\) \{ pickDate\(id\) \}/);
assert.match(editorUi, /JSONObject\(\)\.put\("type", "pickDate"\)\.put\("field", target\)\.put\("date", day\)/);
assert.match(editorUi, /JSONObject\(\)\.put\("type", "pickTime"\)\.put\("field", target\)\.put\("time", pickedTime\(state\.hour, state\.minute\)\)/);
assert.doesNotMatch(code(editorUi), /relativeStartOffset" to null\)(?!\))/, 'the relative start cascade is core\'s');
assert.equal(code(editorUi).match(/"relativeStartOffset"/g).length, 1, 'only the Absolute chip names the relative start');
assert.match(editorUi, /section\.fields\.forEach \{ field\(it\) \}/);
assert.doesNotMatch(code(editorUi), /\.(sort\w*|sorted\w*|groupBy|reversed|shuffled|distinct\w*)\b/);
// No Kotlin date parsing or formatting of stored values: dates show core's labels. Two helpers convert only between the
// picker and core's picker strings: pickedDay (picker output) and pickerStart (core's picker start, yyyy-MM-dd, back into
// the picker); pickerClock splits core's HH:mm picker start into the time picker's hour and minute.
const PICKER_START = /private fun pickerStart\(coreDate: String\): Long\? =\s*runCatching \{ SimpleDateFormat\("yyyy-MM-dd", Locale\.US\)\.apply \{ timeZone = TimeZone\.getTimeZone\("UTC"\) \}\.parse\(coreDate\)\?\.time \}\.getOrNull\(\)/;
assert.match(editorUi, PICKER_START);
assert.equal(editorUi.match(/pickerStart\(/g).length, 2, 'defined once, used once: the date picker\'s start');
assert.match(editorUi, /val state = rememberDatePickerState\(initialSelectedDateMillis = start\?\.let \{ pickerStart\(it\) \}\)/);
assert.match(editorUi, /val \(hour, minute\) = pickerClock\(editor\.view\.fields\.dates\.getValue\(target\)\.pickerTime\)/);
assert.doesNotMatch([editorUi.replace(PICKER_START, ''), model, activity, focusUi, projectsUi, rowUi, areaUi, viewStateKt, menuModel, ...Object.values(menuScreens)].join('\n'),
    /java\.time|LocalDate|Instant|DateTimeFormatter|java\.util\.Calendar|GregorianCalendar|Calendar\.getInstance|(?<!InboxPage|FocusView|ProjectsView|ProjectDetail|AreaFilter|EditorSuggestions|SearchView)\.parse\(|DateFormat\.get|SimpleDateFormat\(\)/);
assert.equal([model, activity, focusUi, projectsUi, rowUi, areaUi, viewStateKt, menuModel, ...Object.values(menuScreens)].join('\n').match(/SimpleDateFormat|\.format\(/g), null);
// A fade is always a layer (Theme.kt fade): Modifier.alpha(1f) drops its layer, which left the capture popup's
// enabled Save pills undrawn on the test phone (runs 31-32).
{
    const { readdirSync } = await import('node:fs');
    const dir = resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.kt'))) {
        assert.doesNotMatch(code(readFileSync(resolve(dir, name), 'utf8')), /\.alpha\(|ui\.draw\.alpha/, `${name} uses Modifier.alpha; use fade`);
    }
}
assert.match(source('Theme.kt'), /fun Modifier\.fade\(alpha: Float\): Modifier = graphicsLayer \{ this\.alpha = alpha \}/);
// RN's Android Switch for Add another (the M3 Switch hid the off thumb): a toggleable Role.Switch node.
assert.match(captureUi, /toggleable\(on, enabled = enabled, role = Role\.Switch\)/);
assert.doesNotMatch(code(captureUi), /material3\.Switch|SwitchDefaults/);
// No Kotlin date formatting or date coloring anywhere in the UI package: dates and their tones are core's (row meta, the Focus date line).
{
    const { readdirSync } = await import('node:fs');
    const dir = resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot');
    // The Calendar composer's time edits are core's edit names (NativeCalendarComposerEdit), not a task's field: that one line is left out.
    const composerTimeEdit = 'put("type", if (field == "start") "startTime" else "endTime")';
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.kt') && file !== 'TaskEditor.kt')) {
        assert.doesNotMatch(code(readFileSync(resolve(dir, name), 'utf8')).replace(composerTimeEdit, ''), /SimpleDateFormat|DateTimeFormatter|LocalDate|java\.time|\bdueDate\b|\bstartTime\b/,
            `${name} formats, parses, or colors a date; only core's meta text is shown`);
    }
}
assert.equal(editorUi.match(/SimpleDateFormat|\.format\(/g).length, 4); // import, pickedDay's constructor and format call, pickerStart's constructor
assert.match(editorUi, /private fun pickedDay\(pickerMillis: Long\): String =\s*SimpleDateFormat\("yyyy-MM-dd", Locale\.US\)\.apply \{ timeZone = TimeZone\.getTimeZone\("UTC"\) \}\.format\(Date\(pickerMillis\)\)/);
assert.equal(editorUi.match(/pickedDay\(/g).length, 2);
assert.match(editorUi, /internal fun pickedTime\(hour: Int, minute: Int\) = "\$\{hour\.toString\(\)\.padStart\(2, '0'\)\}:\$\{minute\.toString\(\)\.padStart\(2, '0'\)\}"/);
assert.equal(editorUi.match(/pickedTime\(/g).length, 3, 'defined once; the editor\'s time picker and the shared ClockPickerDialog (the capture popup\'s due time)');
// A draft date is never read apart: no substring, split, or pattern over a date field's value.
assert.doesNotMatch(code(editorUi), /text\("(dueDate|startTime|reviewAt)"\)\.(substring|split|take|drop|contains|startsWith|endsWith|matches|replace)/);
assert.doesNotMatch(code(editorUi), /\b(due|value)\.(substring|split|take|drop|contains|startsWith|endsWith|matches)\(/);
// Read-only offers only Close; a failed save allows only its exact retry and leaves Back to the system.
assert.match(editorUi, /val locked = busy \|\| failed \|\| editor\.readOnly/);
assert.match(editorUi, /BackHandler\(enabled = !failed\)/);
assert.match(editorUi, /clickable\(enabled = !busy && !failed, role = Role\.Button, onClick = leave\)/);

// Focus reaches core only through CoreHost's two calls, which reach only core's two Focus queries. Kotlin sends Focus's control
// state (FocusModel) with both, and a control's edit with the first; a read that sends neither keeps the flat Focus.
assert.match(coreHost, /fun focus\(limit: Int, controls: String = "", controlEdit: String = ""\): JSONObject = callAsync\("focus", limit, controls, controlEdit\)/);
assert.match(coreHost, /fun focusWindow\(key: String, offset: Int, limit: Int, revision: String, controls: String = ""\): JSONObject =\s*callAsync\("focusWindow", key, offset, limit, revision, controls\)/);
assert.match(hostEntry, /focus\(limit: number, controls = '', controlEdit = ''\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*const focus = unwrap\(contract\.getFocus\(\{ limit, \.\.\.\(controls \? \{ controls: JSON\.parse\(controls\) \} : \{\}\), \.\.\.\(controlEdit \? \{ controlEdit: JSON\.parse\(controlEdit\) \} : \{\}\) \}\)\);/);
assert.match(hostEntry, /focusWindow\(key: string, offset: number, limit: number, revision: string, controls = ''\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getFocusSectionWindow\(\{ key: key as FocusTaskSectionKey, offset, limit, revision, \.\.\.\(controls \? \{ controls: JSON\.parse\(controls\) \} : \{\}\) \}\)\);/);
assert.equal(model.match(/runtime\.focus\(/g).length, 1);
assert.equal(model.match(/runtime\.focusWindow\(/g).length, 1);
assert.match(model, /FocusView\.parse\(runtime\.focus\(PAGE, controls, edit\)\)/, 'every Focus read sends the control state');
assert.match(model, /view\.append\(runtime\.focusWindow\(key, loaded\.rows\.size, PAGE, view\.revision, state\)\)/, 'later windows go with the state core answered');
assert.equal([activity, owner, editorUi, focusUi, projectsUi].join('\n').match(/\.focus\(|focusWindow\(/g), null);
// Rows render in core's order: sections and rows are walked as parsed, never sorted, filtered, or regrouped.
const focusCode = code(focusUi) + code(model.slice(model.indexOf('fun JSONObject.taskRows()'), model.indexOf('private const val PAGE')));
assert.doesNotMatch(focusCode, /\.(sort\w*|sorted\w*|filter(?!Bg\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/);
assert.match(focusUi, /return FocusView\(json\.getString\("revision"\), json\.getString\("dateLabel"\), List\(items\.length\(\)\) \{ index ->/);
assert.match(model, /fun JSONObject\.taskRows\(\): List<TaskRow> = getJSONArray\("rows"\)\.let \{ items ->\s*List\(items\.length\(\)\) \{ index ->/);
assert.match(focusUi, /for \(section in focus\?\.sections\.orEmpty\(\)\) \{/);
assert.match(focusUi, /section\.rows\.forEachIndexed \{ index, task ->/);
// Core's row data is the only row data Focus acts on: laterToday places one subheading, revealLabel is shown as text,
// and the section's focusBlockedLabel disables the star with core's reason.
assert.match(focusUi, /val laterToday = section\.rows\.indexOfFirst \{ it\.laterToday \}/);
assert.equal(code([focusUi, activity, model, rowUi].join('\n')).match(/(?<!"agenda)\.laterToday\b/g).length, 1); // not the label key
assert.match(rowUi, /task\.revealLabel\?\.let \{ MetaText\(it, c\.secondaryText, 600, Modifier\.padding\(top = 4\.dp\)\) \}/);
assert.equal(code([focusUi, activity, model, rowUi].join('\n')).match(/\.revealLabel\b/g).length, 1);
assert.doesNotMatch(code([focusUi, activity, model, rowUi].join('\n')), /revealDate/);
assert.match(focusUi, /star = RowStar\.Shown, starBlocked = section\.focusBlockedLabel/);
assert.doesNotMatch(code(focusUi), /"upcoming"/, 'Focus never names a section to decide a control');
assert.match(rowUi, /val label = blocked \?: t\(if \(task\.isFocusedToday\) "agenda\.removeFromFocus" else "agenda\.addToFocus"\)/);
// A stale Load more reads Focus again from offset 0; it is never shown as an error.
assert.match(model, /if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure[\s\S]{0,200}?readFocus\(runtime, null, depth, state\)/);
// Time-aware refresh: on resume and each minute, only while the Focus list is composed and resumed.
assert.match(focusUi, /LaunchedEffect\(owner\) \{\s*owner\.repeatOnLifecycle\(Lifecycle\.State\.RESUMED\) \{\s*while \(true\) \{\s*model\.refreshFocus\(\)\s*delay\(60_000\)/);
assert.equal(code([activity, model, focusUi].join('\n')).match(/(?<!fun )refreshFocus\(\)/g).length, 3, 'the lifecycle loop, and the boot\'s deferred read (first content, or the tab chosen while the boot ran)');
assert.match(activity, /Screen\.Focus -> FocusList\(model, Modifier\.fillMaxSize\(\)\)/);
// Commands from Focus and a project use the Inbox's command path and its exact-retry lock.
assert.match(rowUi, /fun TaskRowItem\(\s*model: InboxViewModel, task: TaskRow, status: RowStatus = RowStatus\.Hidden, star: RowStar = RowStar\.Hidden,/);
// A task grouped under two Next actions headings shows under each: its heading is part of its key.
assert.match(focusUi, /item\(key = "\$\{section\.key\}:\$\{group\}:\$\{task\.id\}"\) \{\s*GroupedRow\(grouped\) \{\s*TaskRowItem\(model, task,/);
// RN hides a section core counts as empty, "Projects to review" included, and folds a section on its title.
assert.match(focusUi, /if \(section\.total == 0\) continue/);
assert.match(focusUi, /if \(reviewCount > 0\) \{/);
assert.match(focusUi, /if \(!open\) continue/);
assert.match(focusUi, /view\.dateLabel\.uppercase\(\)/, 'the Focus date line is core\'s text');
// Open sections are device-local, under RN's keys and defaults.
assert.match(viewStateKt, /const val FOCUS_VIEW_KEY = "mindwtr:view:focus:v1"/);
assert.match(viewStateKt, /const val PROJECTS_VIEW_KEY = "mindwtr:view:projects:v1"/);
assert.match(viewStateKt, /val FOCUS_SECTION_KEYS = listOf\("focus", "schedule", "next", "upcoming", "reviewDue", "reviewProjects"\)/);
assert.match(focusUi, /onClick = \{ loadMoreFocus\(section\.key\) \}, enabled = writable && !busy && failedAction == null/);
// The selected list survives rotation (ViewModel) and process death (SavedStateHandle).
assert.match(model, /saved\.get<String>\("screen"\)/);
assert.match(model, /screen = target\s+saved\["screen"\] = target\.name/);

// Labels: every word on screen comes from core's getStrings. One Kotlin map of core keys, filled at boot and
// read again right after setLanguage; it holds no text of its own (a key core lacks shows as the key).
const enSource = readFileSync(resolve(app, '../../packages/core/src/i18n/locales/en.ts'), 'utf8');
// A key is quoted either way in en.ts (a value holding a quote is double-quoted, attachments.linkBatchHint).
const enKeys = new Set([...enSource.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"):/gm)].map(([, single, double]) => single ?? double));
const labelBlock = labelsKt.slice(labelsKt.indexOf('val LABEL_KEYS = listOf('), labelsKt.indexOf('object Labels'));
const labelKeys = [...code(labelBlock).matchAll(/"([^"]*)"/g)].map(([, name]) => name);
assert(labelKeys.length > 0 && labelKeys.length <= 500 && new Set(labelKeys).size === labelKeys.length, 'LABEL_KEYS: unique, at most getStrings\' 500');
for (const name of labelKeys) assert(enKeys.has(name), `LABEL_KEYS: ${name} is not a key in core's en.ts`);
assert.match(labelsKt, /operator fun get\(name: String\): String = strings\[name\] \?: name\.also\(::missing\)/);
assert.match(labelsKt, /strings = LABEL_KEYS\.filter\(values::has\)\.associateWith\(values::getString\)/);
assert.match(labelsKt, /if \(logged\.add\(name\)\) Log\.w\(/, 'a missing key is logged once');
assert.equal(kotlinFiles.join('\n').match(/Labels\.load\(/g).length, 1);
assert.match(owner, /runtime\.language\(stored \?: "", Locale\.getDefault\(\)\.toLanguageTag\(\)\)\s+Labels\.load\(runtime\.strings\(LABEL_KEYS\)\)/);
assert.match(owner, /runtime\.start\([^\n]*\)\s+setLanguage\(runtime, language \?: legacy\?\.language\)\s+loadTheme\(runtime, legacy\?\.theme\)\s+(?:\/\/[^\n]*\s+)*recoverInstalls\(installer\)\s+if \(replay\(runtime\)\) recovered\(app, runtime, deferSync = true\)\s+(?:\/\/[^\n]*\s+)*deferredWidgets\.hold\(runtime\)\s+return runtime/);
// After a finished replay (the boot's, the owed retry's, CoreWork's): the queue drain, then sync (StartOrder, StartOrderTest). Any
// drain that did not finish becomes the screens' owed journal retry, holds sync back, and CoreWork retries it.
assert.match(owner, /fun recovered\(app: Application, runtime: CoreHost, deferSync: Boolean = false\): Boolean = StartOrder\.afterReplay\(\s+drain = \{ drain\(runtime, queue\(app\), app\) \},\s+owe = \{ message -> recordFailure\(PendingFailure\(FailedAction\("journal", ""\), message, null\)\) \},\s+retryLater = \{ runCatching \{ CoreWork\.retryDrain\(app\) \}[^\n]*\},\s+(?:\/\/[^\n]*\s+)*startSync = \{\s+if \(deferSync\) deferredSync\.set \{\s+startSync\(app, runtime\)\s+startReminders\(runtime\)\s+\} else \{\s+startSyncWithScreen\(app, runtime\)\s+startReminders\(runtime\)\s+\}\s+\},\s+refreshWidgets = \{ refreshWidgets\(runtime\) \},\s+\)/);
assert.match(source('StartOrder.kt'), /Drain\.Done -> \{\s+startSync\(\)\s+return true\s+\}\s+Drain\.Unswept -> \{\s+startSync\(\)\s+(?:\/\/[^\n]*\s+)*refreshWidgets\(\)\s+retryLater\(\)\s+\}\s+Drain\.Waiting -> retryLater\(\)\s+is Drain\.Failed -> \{\s+owe\(result\.message\)\s+retryLater\(\)\s+\}/);
assert.match(source('CoreWork.kt'), /fun retryDrain\(context: Context\) = enqueue\(context, CoreJob\.INGEST, emptyMap\(\), ExistingWorkPolicy\.KEEP\)/, 'a retry never cancels a running drain');
// S4a: the background sync job, as RN's expo-background-task worker: core's interval, a network, its next run appended after it; a
// reconcile keeps a queued or running job (KEEP: RN's #1001 fix), only core's "off" cancels it; RN's own worker is cancelled at every
// process start. Core's runner and schedule decision on the host's ports are tested in bundle/host-sync.test.ts (bun), run here.
{
    const coreWork = source('CoreWork.kt');
    const rnScheduler = readFileSync(resolve(app, '../../node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt'), 'utf8');
    const coreRunner = readFileSync(resolve(app, '../../packages/core/src/mobile-background-sync.ts'), 'utf8');
    assert.equal(/const val RN_SYNC_WORK = "(\w+)"/.exec(coreWork)[1], /WORKER_IDENTIFIER = "(\w+)"/.exec(rnScheduler)[1], 'RN\'s worker name is Expo\'s');
    assert.equal(/const val SYNC_INTERVAL_MINUTES = (\d+)L/.exec(coreWork)[1], /MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES = (\d+);/.exec(coreRunner)[1], 'core\'s interval');
    assert.match(rnScheduler, /setRequiredNetworkType\(NetworkType\.CONNECTED\)/);
    assert.match(coreWork, /\.setInitialDelay\(SYNC_INTERVAL_MINUTES, TimeUnit\.MINUTES\)\s+\.setConstraints\(Constraints\.Builder\(\)\.setRequiredNetworkType\(NetworkType\.CONNECTED\)\.build\(\)\)/);
    assert.match(coreWork, /if \(on\) work\.enqueueUniqueWork\(SYNC_WORK, ExistingWorkPolicy\.KEEP, syncRequest\(\)\) else work\.cancelUniqueWork\(SYNC_WORK\)/);
    assert.match(coreWork, /enqueueUniqueWork\(SYNC_WORK, ExistingWorkPolicy\.APPEND_OR_REPLACE, syncRequest\(\)\)/);
    // Review S4a 4: core hears "scheduled" only once WorkManager stored it; a refusal or no answer throws back to core.
    assert.match(coreWork, /fun scheduleSyncStored\(context: Context, on: Boolean\) \{\s+scheduleSync\(context, on\)\.result\.get\(STORE_WAIT_SECONDS, TimeUnit\.SECONDS\)\s+\}/);
    assert.equal(coreWork.match(/enqueueUniqueWork\(SYNC_WORK/g).length, 2, 'the sync job is queued only by core\'s decision and by its own run');
    assert.match(coreWork, /syncAgain = \{ isStopped \|\| runCatching \{ syncAgain\(app\)\.result\.get\(STORE_WAIT_SECONDS, TimeUnit\.SECONDS\) \}/, 'a cancelled run queues no next one; a next run not stored retries this one (review S4a 3)');
    assert.match(source('MindwtrApplication.kt'), /runCatching \{ CoreWork\.cancelRnSync\(this\) \}/);
    assert.match(hostEntry, /scheduleBackgroundSync: \(on\) => \{ const bridge = native\(\); if \(bridge\.bgSyncSchedule\) checked\(bridge\.bgSyncSchedule\(on\)\); \},/);
    const tested = spawnSync('bun', ['test', 'apps/android-native/bundle/host-sync.test.ts'], { cwd: resolve(app, '../..'), encoding: 'utf8' });
    assert.equal(tested.status, 0, `bundle/host-sync.test.ts: ${tested.stderr.slice(-1500)}`);
    // D8: the channel is the build's flavor, read by core as RN's isFossBuild; no host passes a fixed false any more.
    assert.match(readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8'), /create\("play"\) \{\s+dimension = "channel"\s+buildConfigField\("boolean", "FOSS", "false"\)\s+\}\s+create\("foss"\) \{\s+dimension = "channel"\s+buildConfigField\("boolean", "FOSS", "true"\)/);
    assert.match(coreHost, /engine\.globalObject\.setProperty\("__mindwtrFossBuild", BuildConfig\.FOSS\)/);
    assert.match(hostEntry, /const isFossBuild = globalThis\.__mindwtrFossBuild === true;/);
    const bundleHosts = ['host-sync.ts', 'host-ai.ts'].map((name) => readFileSync(resolve(app, 'bundle', name), 'utf8')).join('\n');
    assert.doesNotMatch(bundleHosts, /isFossBuild: false/, 'every host reads the flavor');
}
// The queue drain (RN's startup drain; CoreWork's ingest job too): after the journal replay, before any screen, entry point or
// sync gets the host; never while a save is owed; a failed save becomes the journal's owed retry, which drains again.
assert.match(owner, /fun queue\(app: Application\) = File\(app\.filesDir, PendingCaptureWriter\.DIRECTORY\)/, 'the queue is RN\'s writer\'s folder');
assert.match(owner, /private fun drain\(runtime: CoreHost, queue: File, app: Application\): StartOrder\.Drain \{\s+if \(failure != null\) return StartOrder\.Drain\.Waiting\s+(?:\/\/[^\n]*\s+)*val unswept = runCatching \{ CheckoffStore\.sweep\(app\)\.failed > 0 \}[^\n]*\.getOrDefault\(true\)\s+if \(unswept\) runtime\.logLine\("Native Android queue drain", JSONObject\(\)\.put\("outcome", "unswept"\)\)\s+val drained = if \(unswept\) StartOrder\.Drain\.Unswept else StartOrder\.Drain\.Done\s+when \(StartOrder\.queueEmpty\(queue\.list\(\), queue\.exists\(\)\)\) \{\s+true -> return drained\s+(?:\/\/[^\n]*\s+)*null -> \{\s+runtime\.logLine\("Native Android queue drain", JSONObject\(\)\.put\("outcome", "unreadable"\)\)\s+return StartOrder\.Drain\.Unswept\s+\}\s+false -> Unit\s+\}\s+return try \{\s+val ingested = runtime\.ingestPendingCaptures\(UUID\.randomUUID\(\)\.toString\(\)\)/, 'a failed check-off sweep is retried, the queue still drained');
assert.match(owner, /val ingested = [^\n]+\n\s+(?:\/\/[^\n]*\s+)*runCatching \{ CoreWork\.owedUploads\(app\)\.add\(ingested\) \}[^\n]+\n[^\n]+"drained"[^\n]+\n\s+drained\n/, 'what a drain stored is owed to CoreWork\'s next background run, across process death (S4a, review 2)');
assert.match(source('CoreWork.kt'), /return host\.backgroundSync\(trigger, if \(ProcessCoreHost\.appActive\) 0 else stored\)\.also \{ owed\.settle\(stored\) \}/, 'an owed upload is settled only once its run settled');
assert.match(owner, /\.put\("error", message\.substringBefore\(':'\)\)\)\s+StartOrder\.Drain\.Failed\(message\)/);
// The runner's lines go through core's logger (logcat, and RN's diagnostics log file), their fields in context; a failure's code only.
assert.match(owner, /runtime\.logLine\("Native Android queue drain", JSONObject\(\)\.put\("outcome", "drained"\)\.put\("ingested", ingested\)\)/);
assert.match(owner, /runtime\.logLine\("Native Android queue drain", JSONObject\(\)\.put\("outcome", "failed"\)\.put\("error", message\.substringBefore\(':'\)\)\)/);
assert.match(coreHost, /fun logLine\(message: String, context: JSONObject\) \{\s+runCatching \{ callAsync\("logLine", message, context\.toString\(\)\) \}\.onFailure \{ Log\.i\(TAG, "\$message \$context"\) \}/);
assert.match(hostEntry, /logLine\(message: string, contextJson: string\): string \{\s+return submit\(async \(\) => \{\s+try \{\s+logInfo\(message, \{ scope: 'native-android', context: JSON\.parse\(contextJson\) as Record<string, unknown> \}\);/);
assert.match(coreHost, /fun ingestPendingCaptures\(requestId: String\): JSONObject = callAsync\("ingest", requestId\)/);
assert.equal(kotlinFiles.join('\n').match(/runtime\.language\(|runtime\.strings\(/g).length, 2);
// Core's editor statuses and priorities each have their label key.
const contractSource = readFileSync(resolve(app, '../../packages/core/src/native-host-contract.ts'), 'utf8');
for (const [list, prefix] of [['EDITOR_STATUSES', 'status'], ['EDITOR_PRIORITIES', 'priority']]) {
    const values = [...new RegExp(`const ${list} = \\[([^\\]]*)\\]`).exec(contractSource)[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
    for (const value of values) assert(labelKeys.includes(`${prefix}.${value}`), `LABEL_KEYS lacks ${prefix}.${value}`);
}
assert.match(editorUi, /for \(status in editor\.view\.statuses\)/);
assert.match(editorUi, /ChoiceChips\(editor, "priority", editor\.view\.priorities, !locked, t\("taskEdit\.priorityLabel"\), \{ t\("priority\.\$it"\) \}\)/);
// Every label key core's editor model can send (recurrence choices, energy levels, section titles) is in LABEL_KEYS.
{
    const modelSource = readFileSync(resolve(app, '../../packages/core/src/task-editor-model.ts'), 'utf8');
    for (const [, key] of modelSource.matchAll(/labelKey: '([^']+)'/g)) assert(labelKeys.includes(key), `LABEL_KEYS lacks ${key}`);
    for (const value of [...modelSource.matchAll(/TASK_EDITOR_ENERGY_LEVEL_OPTIONS: TaskEnergyLevel\[\] = \[([^\]]*)\]/g)][0][1].matchAll(/'([^']+)'/g)) {
        assert(labelKeys.includes(`energyLevel.${value[1]}`), `LABEL_KEYS lacks energyLevel.${value[1]}`);
    }
    for (const id of ['scheduling', 'organization', 'details']) assert(labelKeys.includes(`taskEdit.${id}`), `LABEL_KEYS lacks taskEdit.${id}`);
}
// No literal text reaches a Text, a content description, or a click label; key literals are label keys.
// Pass 8's Calendar and Board screens and models are held to the same rule.
const pass8Sources = { calendarModel: source('CalendarModel.kt'), calendarUi: source('CalendarScreen.kt'), boardModel: source('BoardModel.kt'), boardUi: source('BoardScreen.kt') };
for (const [name, text] of Object.entries({ activity, model, editorUi, focusUi, projectsUi, themeKt, iconsKt, rowUi, areaUi, viewStateKt, searchUi, processUi, captureUi, captureModalUi, captureModalModel, menuModel, ...menuScreens, ...pass8Sources })) {
    // Icons.kt's bySymbol keys are core's SF Symbols names (more-menu-model.ts), not label keys.
    const body = code(text).replace(/val bySymbol = mapOf\([\s\S]*?\n {4}\)/, '');
    for (const [, key] of body.matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)"/g)) assert(labelKeys.includes(key), `${name}: ${key} is not in LABEL_KEYS`);
    for (const [, rest] of body.matchAll(/(?:\bText\(|contentDescription = |onClickLabel = )([^\n]*)/g)) {
        // Core's JSON is read by key (getString("label")); a key names a field of core's text, it is not text.
        // A test tag (a Modifier's, or one set in a control's semantics block) names the control for the checks; it is not text.
        for (const [, literal] of rest.replace(/\b(t|testTag|getString|optString|text|getJSONObject|optJSONObject|getBoolean|optBoolean|getInt|menuText|menuObjects)\("[^"]*"\)/g, '').replace(/\btestTag = "[^"]*"/g, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
            if (labelKeys.includes(literal)) continue;
            assert.doesNotMatch(literal.replace(/\$\{[^}]*\}|\$\w+/g, ''), /\p{L}/u, `${name}: hard-coded UI text "${literal}"`);
        }
    }
}
assert.match(activity, /Text\(t\(label\), style = rnText\(10, if \(active\) 700 else 600, 12\)/);
assert.match(activity, /private fun RowScope\.TabItem\(model: InboxViewModel, tab: Screen, icon: ImageVector, label: String = tab\.label\)/);
assert.match(model, /enum class Screen\(val label: String\) \{ Inbox\("tab\.inbox"\), Focus\("tab\.next"\), Projects\("nav\.projects"\) \}/);
// A failed boot shows only its message, found by a test tag, and no command control.
assert.match(activity, /\} else if \(!writable\) \{[^}]*Text\(error\.orEmpty\(\), color = MaterialTheme\.colorScheme\.error, modifier = Modifier\.testTag\("boot-failure"\)\.padding\(24\.dp\)\)\s*\} else \{/);
assert.match(activity, /if \(open != null && writable\) TaskEditorScreen\(model, open\)/);

// Landscape: the Inbox's controls, Process button and scope line are the list's first items; only the header, the tabs (and a
// failure, and the bulk bar while selecting) stay fixed.
assert.match(inboxUi, /LazyColumn\(Modifier\.weight\(1f\)\.fillMaxWidth\(\), contentPadding = PaddingValues\(bottom = 12\.dp\)\) \{\s*val view = shown\?\.view \?: return@LazyColumn\s*item\(key = "toolbar"\)[\s\S]*?item\(key = "header"\)[\s\S]*?items\(shown\.items, key = \{ it\.key \}\)/);
assert.match(activity, /Screen\.Inbox -> InboxList\(model, Modifier\.fillMaxSize\(\)\)/);
// Capture: RN's center tab button opens RN's capture popup (CaptureScreen.kt), on core's quick capture contract.
assert.match(activity, /CaptureButton\(model\)[\s\S]*?clickable\(role = Role\.Button\) \{ model\.menu\.closeSheet\(\); model\.openCapture\(\) \}/);
assert.match(activity, /capture\?\.let \{ CapturePopup\(model, it\) \}/);
assert.doesNotMatch(code(activity + model), /CaptureSheet|createInboxTask|showCapture/, 'the pass-1 capture sheet is gone');
// The tab bar: RN's order, Menu last (it opens RN's More sheet), and RN's lucide icons.
const tabBar = activity.slice(activity.indexOf('private fun TabBar('), activity.indexOf('private fun RowScope.TabItem('));
assert.deepEqual([...tabBar.matchAll(/TabItem\(model, Screen\.(\w+)|CaptureButton\(model\)|MenuTab\(model\)/g)]
    .map(([whole, tab]) => tab ?? (whole.startsWith('Capture') ? 'capture' : 'menu')), ['Focus', 'Inbox', 'capture', 'Projects', 'menu']);
// The failure text stays in the accessibility tree: drawn above the list, a live region, reached first, and the list is clipped.
const banner = activity.slice(activity.indexOf('fun FailureBanner('), activity.indexOf('private fun TabBar('));
assert.match(banner, /\.zIndex\(1f\)/);
assert.match(banner, /isTraversalGroup = true; traversalIndex = -1f/);
assert.match(banner, /Text\(message,[\s\S]*?liveRegion = LiveRegionMode\.Assertive/);
assert(activity.indexOf('FailureBanner(message)') < activity.indexOf('Screen.Inbox -> InboxList('), 'the banner sits above the lists');
assert.match(activity, /Box\(Modifier\.weight\(1f\)\.fillMaxWidth\(\)\.background\(c\.bg\)\.clipToBounds\(\)\)/);
// Section titles draw RN's capitals but expose core's own title and count.
assert.match(activity, /clearAndSetSemantics \{ text = AnnotatedString\(spoken\); heading\(\) \}/);
assert.match(activity, /val spoken = if \(count == null\) title else "\$title · \$count"/);

// Theme: one Kotlin theme object holds RN's palettes, value for value, and every color the screens draw.
const mobile = resolve(app, '../mobile');
const hexes = (text) => [...text.matchAll(/"(#[0-9A-Fa-f]{6})"/g)].map(([, hex]) => hex.toUpperCase());
const kotlinPalette = (name) => hexes(new RegExp(`${name} palette\\(([^)]*)\\)`).exec(themeKt)?.[1] ?? '');
const FIELDS = ['bg', 'cardBg', 'taskItemBg', 'text', 'secondaryText', 'icon', 'border', 'tint', 'onTint', 'tabIconDefault',
    'tabIconSelected', 'inputBg', 'danger', 'success', 'warning', 'filterBg'];
assert.match(themeKt, new RegExp(`data class ThemeColors\\(\\s*${FIELDS.map((field) => `val ${field}: Color,`).join('\\s*')}\\s*\\)`), 'ThemeColors has RN\'s fields in order');
// RN's constants/theme-presets.ts re-exports core's table.
const presetSource = readFileSync(resolve(app, '../../packages/core/src/theme-presets.ts'), 'utf8');
const presetBlocks = [...presetSource.matchAll(/^ {4}'?([\w-]+)'?: \{\n([\s\S]*?)\n {4}\},/gm)];
// The table is Record<ThemeStatusPreset, …>: every name in that union must parse as a block.
const statusPresetUnion = /export type ThemeStatusPreset = ([^;]+);/.exec(readFileSync(resolve(app, '../../packages/core/src/theme-scheme.ts'), 'utf8'))[1];
assert.deepEqual(presetBlocks.map(([, preset]) => preset).sort(), [...statusPresetUnion.matchAll(/'([\w-]+)'/g)].map(([, preset]) => preset).sort(),
    'every bespoke theme preset is read');
for (const [, preset, body] of presetBlocks) {
    const values = Object.fromEntries([...body.matchAll(/(\w+): '(#[0-9A-Fa-f]{6})'/g)].map(([, field, hex]) => [field, hex.toUpperCase()]));
    assert.deepEqual(kotlinPalette(`"${preset}" to`), FIELDS.map((field) => values[field]), `preset ${preset} matches RN`);
}
const m3Source = readFileSync(resolve(mobile, 'constants/material3/m3-color.ts'), 'utf8');
const m3Role = (scheme, role) => new RegExp(`${scheme}: \\{[\\s\\S]*?\\b${role}: '(#[0-9A-Fa-f]{6})'`).exec(m3Source)[1].toUpperCase();
const m3Map = { bg: 'background', cardBg: 'surfaceContainer', taskItemBg: 'surfaceContainerHigh', text: 'text', secondaryText: 'secondaryText',
    icon: 'secondaryText', border: 'outline', tint: 'primary', onTint: 'onPrimary', tabIconDefault: 'secondaryText', tabIconSelected: 'primary',
    inputBg: 'surfaceVariant', danger: 'error', success: 'success', warning: 'warning', filterBg: 'surfaceVariant' };
for (const scheme of ['light', 'dark']) {
    assert.deepEqual(kotlinPalette(`M3_${scheme.toUpperCase()} =`), FIELDS.map((field) => m3Role(scheme, m3Map[field])), `Material 3 ${scheme} matches RN`);
}
const tokenSource = readFileSync(resolve(mobile, 'hooks/use-theme-tokens.ts'), 'utf8');
const generic = tokenSource.slice(tokenSource.indexOf('const isDark = theme.isDark;'), tokenSource.indexOf('const FALLBACK: ThemeTokens'));
const baseSource = readFileSync(resolve(mobile, 'constants/theme.ts'), 'utf8');
const baseColor = (scheme, name) => {
    const block = new RegExp(`${scheme}: \\{([\\s\\S]*?)\\}`).exec(baseSource)[1];
    const value = new RegExp(`\\b${name}: ([^,]+),`).exec(block)[1].trim();
    return (value.startsWith("'") ? value.slice(1, -1) : new RegExp(`const ${value} = '([^']+)'`).exec(baseSource)[1]).toUpperCase();
};
const genericValue = (scheme, field) => {
    const expression = new RegExp(`\\b${field}: ([^,\\n]+)`).exec(generic)[1];
    const choice = expression.includes('?') ? expression.split('?')[1].split(':')[scheme === 'dark' ? 0 : 1].trim() : expression.trim();
    const colors = /^Colors\.(light|dark)\.(\w+)$/.exec(choice);
    return colors ? baseColor(colors[1], colors[2]) : choice.replace(/'/g, '').toUpperCase();
};
for (const scheme of ['light', 'dark']) {
    assert.deepEqual(kotlinPalette(`${scheme.toUpperCase()} =`), FIELDS.map((field) => genericValue(scheme, field)), `RN default ${scheme} matches`);
}
// No color is written anywhere else: every other file draws with LocalTheme.
for (const [name, text] of Object.entries({ activity, model, editorUi, focusUi, projectsUi, labelsKt, iconsKt, owner, rowUi, areaUi, viewStateKt, searchUi, processUi, captureUi, captureModalUi, captureModalModel, menuModel, ...menuScreens })) {
    assert.doesNotMatch(code(text), /\bColor\(|Color\.(Black|White|Red|Green|Blue|Gray|Yellow|Cyan|Magenta|DarkGray|LightGray|Transparent)\b|parseColor|"#[0-9A-Fa-f]{3,8}"|0x[0-9A-Fa-f]{8}/,
        `${name} writes a color; colors live only in Theme.kt`);
}
assert.equal([activity, focusUi, projectsUi, rowUi, areaUi, searchUi, processUi, captureUi, captureModalUi, ...Object.values(menuScreens)].join('\n').match(/MaterialTheme\.typography/g), null, 'the lists use RN\'s type (rnText), not Material\'s');
assert.equal(code(activity).match(/MindwtrTheme\(/g).length, 1, 'one theme wraps the whole app');
// Core classifies the theme and owns its hues; Kotlin never names a theme mode.
assert.doesNotMatch(code(themeKt + owner), /"(system|material3-light|material3-dark)"/);
assert.match(themeKt, /json\.getString\("preset"\), json\.getBoolean\("material"\), if \(json\.isNull\("scheme"\)\) null else json\.getString\("scheme"\)/);
assert.match(coreHost, /fun theme\(stored: String\): JSONObject = callAsync\("theme", stored\)/);
assert.equal(owner.match(/runtime\.theme\(/g).length, 1);
assert.match(owner, /runCatching \{ ThemeChoice\.load\(runtime\.theme\(stored \?: ""\)\) \}/, 'a failed theme read keeps RN\'s default look');
const themeCall = hostEntry.slice(hostEntry.indexOf('theme(stored: string): string {'), hostEntry.indexOf('    projects(): string {'));
assert.match(themeCall, /const mode = typeof synced === 'string' && synced \? synced : \(stored \|\| 'system'\);/, 'RN: the synced setting wins over the device-local choice');
assert.match(themeCall, /themeDescriptor\(mode\)/);
assert.doesNotMatch(themeCall, /requireSaved/);
// Rows read core's meta: the parts in core's order (detail parts hidden, as RN's lists and default Focus hide them),
// core's due tone mapped to RN's colors, the strip from meta.priority, and TalkBack's label from meta.accessibilityLabel.
assert.match(model, /fun JSONObject\.taskRow\(\) = getJSONObject\("meta"\)\.let \{ meta ->/);
assert.match(model, /meta\.getJSONArray\("parts"\)\.let \{ parts -> List\(parts\.length\(\)\) \{ parts\.getJSONObject\(it\)\.metaPart\(\) \} \}/);
assert.match(rowUi, /val parts = if \(details\) meta\.parts else meta\.parts\.filter \{ !it\.detail \}/, 'detail parts show only where RN\'s list shows them');
assert.match(rowUi, /for \(part in parts\) MetaPartView\(part\)/);
assert.match(rowUi, /"due" -> MetaText\(part\.text, when \(part\.tone\) \{ "overdue" -> c\.danger; "dueSoon" -> c\.warning; else -> c\.secondaryText \}, 600\)/);
assert.match(rowUi, /val strip = theme\.priority\(meta\.priority\)/);
assert.match(rowUi, /contentDescription = meta\.accessibilityLabel/);
assert.match(rowUi, /coreColorOrNull\(part\.dotColor\) \?: c\.tint/, 'a null dot color is the tint, as RN');
assert.doesNotMatch(code(model), /"dueDate"|"startTime"|"projectTitle"/, 'no row reads core\'s raw dates');
// Icons are lucide's own paths, with its ISC notice.
assert.match(iconsKt, /Lucide is ISC licensed/);
assert.match(iconsKt, /val Target = lucide\("Target", circle\(12, 12, 10\), circle\(12, 12, 6\), circle\(12, 12, 2\)\)/);

// Projects: read only through CoreHost's two calls, which reach only core's two project queries.
assert.match(coreHost, /fun projects\(\): JSONObject = callAsync\("projects"\)/);
assert.match(coreHost, /fun projectDetail\(id: String, offset: Int, limit: Int, revision: String\): JSONObject =\s*callAsync\("projectDetail", id, offset, limit, revision\)/);
assert.match(coreHost, /fun strings\(keys: List<String>\): JSONObject = callAsync\("strings", JSONArray\(keys\)\.toString\(\)\)/);
assert.match(hostEntry, /projects\(\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getProjects\(\)\);/);
assert.match(hostEntry, /projectDetail\(id: string, offset: number, limit: number, revision: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getProjectDetail\(\{ projectId: id, offset, limit, revision: revision \|\| undefined \}\)\);/);
// Labels are not stored data: a failed save never blocks them.
const labelCalls = hostEntry.slice(hostEntry.indexOf('language(stored: string, system: string): string {'), hostEntry.indexOf('    projects(): string {'));
assert.match(labelCalls, /contract\.setLanguage\(\{ storedLanguage: stored \|\| null, systemLocale: system \|\| null \}\)/);
assert.match(labelCalls, /contract\.getStrings\(\{ keys: JSON\.parse\(keysJson\) as string\[\] \}\)/);
assert.doesNotMatch(labelCalls, /requireSaved/);
assert.equal(model.match(/runtime\.projects\(\)/g).length, 2, 'read() after boot and commands, and the resume refresh');
assert.equal(model.match(/runtime\.projectDetail\(/g).length, 2, 'the first window and the next');
assert.equal([activity, owner, editorUi, focusUi, projectsUi].join('\n').match(/\.projects\(\)|projectDetail\(/g), null);
// Projects render only core's order: groups, areas, rows, and detail items are walked as parsed, never sorted or dropped.
assert.doesNotMatch(code(projectsUi) + code(model), /\.(sort\w*|sorted\w*|filter(?!Bg\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/);
assert.match(projectsUi, /val PROJECT_BUCKETS = listOf\("active" to "projects\.activeSection", "deferred" to "projects\.deferredSection", "archived" to "projects\.closed"\)/);
for (const walk of [/List\(groups\.length\(\)\) \{ index ->/, /List\(rows\.length\(\)\) \{ row ->/, /List\(items\.length\(\)\) \{ index ->/,
    /for \(\(bucket, heading\) in PROJECT_BUCKETS\) \{/, /for \(group in groups\) \{/, /for \(row in group\.projects\) item/,
    /for \(entry in detail\?\.items\.orEmpty\(\)\) when \(entry\)/]) assert.match(projectsUi, walk);
assert.match(projectsUi, /group\.areaName \?: t\("projects\.noArea"\)/);
// The project status line is core's text (Completed or Cancelled for a closed project).
assert.match(projectsUi, /Text\(row\.statusLabel, style = rnText\(12, 400\), color = color\)/);
assert.doesNotMatch(code(projectsUi), /"list\.done"/);
assert.match(projectsUi, /val open = !collapsible \|\| \(if \(bucket == "deferred"\) projectsView\.showDeferred else projectsView\.showArchived\)/, 'Deferred and Archived start closed (RN\'s default)');
assert.match(projectsUi, /val areaKey = group\.areaId \?: "no-area"/);
// A read-only project's rows have no Complete; its cue is core's value, shown with mobile's label.
assert.match(projectsUi, /val completable = detail\?\.readOnly == false/);
assert.match(projectsUi, /TaskRowItem\(model, entry\.row, status = RowStatus\.Badge, completable = completable,\s*note = entry\.sequenceCue\?\.let\(CUE_KEYS::get\)\?\.let\(::t\), available = entry\.sequenceCue == "available"\)/);
// A stale window restarts the project from offset 0; it is never shown as an error.
assert.match(model, /if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure\s+return if \(start == null\) view else readProject\(runtime, id, null, depth\)/);
assert.match(model, /if \(id != openProjectId\) return\s+if \(detail == null\) keepProject\(null\)\s+project = detail/,
    'a reply for a closed project is dropped; a project core no longer has closes');
assert.match(model, /if \(failure\.message\?\.startsWith\("TASK_NOT_FOUND"\) != true\) throw failure\s+null/);
// Read on every resume of the Projects tab and after every command, as Focus is.
assert.match(projectsUi, /LaunchedEffect\(owner\) \{\s*owner\.repeatOnLifecycle\(Lifecycle\.State\.RESUMED\) \{ model\.refreshProjects\(\) \}/);
assert.equal(code([activity, model, projectsUi].join('\n')).match(/(?<!fun )refreshProjects\(\)/g).length, 3, 'the lifecycle loop, and the boot\'s deferred read (first content, or the tab chosen while the boot ran)');
assert.match(model, /ProjectsView\.parse\(runtime\.projects\(\)\) else null,\s*at\.project,\s*if \(shown == null \|\| shown == Screen\.Projects\) readOpen\(runtime, at\) else null,/);
// The open project survives rotation (ViewModel) and process death (SavedStateHandle); Back closes it unless a retry is owed.
assert.match(model, /var openProjectId by mutableStateOf\(saved\.get<String>\("project"\)\)/);
assert.match(model, /openProjectId = id\s+saved\["project"\] = id/);
assert.match(projectsUi, /BackHandler\(enabled = failedAction == null\) \{ closeProject\(\) \}/);

// Global search: core's searchTasks is a background read (per-view freshness, and an answer for another query is dropped
// by core's echoed query); saving a search is a perform(action) with its request UUID kept with the dialog.
assert.match(coreHost, /fun searchTasks\(json: String\): JSONObject = callAsync\("search", json\)/);
assert.match(coreHost, /fun saveSearch\(json: String\): JSONObject = callAsync\("saveSearch", json\)/);
assert.match(hostEntry, /search\(json: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*const input = JSON\.parse\(json\);\s*return unwrap\(await contract\.searchTasks\(\{ \.\.\.input, filters: input\.filters \?\? DEFAULT_GLOBAL_SEARCH_FILTERS \}\)\);/);
// Core owns what Kotlin once copied (core batch 4946dca7a): the search defaults (defaultFilters, and core's constant for the first
// read), each chip's cleared filters, the cancelled flag, the Markdown-free note preview, the More-options edit, and the picked-day edit.
assert.doesNotMatch(code(searchUi), /defaultSearchFilters|fun JSONObject\.(cleared|removed)\(|"cancelled"\)? *\}|getString\("kind"\) == "cancelled"|"(includeReference|hideFutureTasks|duePreset|scope|selectedArea)", *(true|false|"all"|"any")\)/,
    'no Kotlin copy of core\'s search defaults, chip clearing, or cancelled detection');
assert.match(searchUi, /row\.getBoolean\("cancelled"\)/);
assert.match(searchUi, /\{ focusManager\.clearFocus\(\); showSearchFilters\(true\) \}/, 'RN blurs the search field before its filter sheet opens');
assert.match(searchUi, /it\.getString\("label"\) to it\.getJSONObject\("clearedFilters"\)/);
assert.match(searchUi, /json\.getJSONObject\("defaultFilters"\)/);
assert.doesNotMatch(code(processUi), /"setDate"|"toggleAdvancedOptions"|take\(200\)|\.trim\(\)\.take/, 'no Kotlin copy of core\'s picked-day edit, More-options edit, or note preview');
assert.match(processUi, /send\(JSONObject\(it\.getJSONObject\("pick"\)\.toString\(\)\)\.put\("day", day\)\)/);
assert.match(processUi, /send\(more\.getJSONObject\("edit"\)\)/);
assert.match(processUi, /capture\.getString\("notePreview"\)/);
assert.doesNotMatch(code(searchUi + processUi), /Pending core field/);
assert.doesNotMatch(searchUi + processUi, /Pending core field/, 'the pending-core comments are gone with the copies');
assert.match(hostEntry, /saveSearch\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('saveSearch', await contract\.saveSearch\(JSON\.parse\(json\)\)\)\);/);
assert.match(model, /background\(listOf\(Part\.Search\), \{ runtime -> SearchView\.parse\(runtime\.searchTasks\(request\)\) \}\) \{ view, mine ->\s+if \(fresh\(mine, Part\.Search\) && view\.query == search\?\.query\?\.trim\(\)\) searchView = view/);
assert.equal(model.match(/runtime\.searchTasks\(/g).length, 1);
assert.match(model, /FailedAction\("saveSearch", current\.saveRequestId, current\.query\.trim\(\), patch = mapOf\("name" to name\.trim\(\)\)\)/);
assert.match(model, /private fun sendSaveSearch\(action: FailedAction\) = perform\(action\) \{ runtime ->\s+try \{\s+runtime\.saveSearch\([^\n]*\.put\("requestId", action\.id\)\.toString\(\)\)[\s\S]{0,400}?acknowledged\(action\)/);
// The submitted Save Search request rides the screen state before the call, locks the dialog, and is reconciled after process death.
assert.match(model, /keepSearch\(current\.copy\(submitted = action\.patch\["name"\]\)\)\s+sendSaveSearch\(action\)/);
assert.match(model, /current\.submitted\?\.let \{ name -> if \(failedAction == null\) saveSearchAction\(current, name\)\.let \{ failedAction = it; sendSaveSearch\(it\) \} \}/);
assert.match(searchUi, /val owed = failedAction != null \|\| state\.submitted != null/);
assert.match(model, /if \(action\.kind == "saveSearch"\) keepSearch\(SearchState\(action\.title, saveName = action\.patch\["name"\], saveRequestId = action\.id, submitted = action\.patch\["name"\]\)\)/,
    'a new screen reopens the save dialog on an owed save, never re-sends it');
assert.match(searchUi, /failedAction == null \|\| failedAction == saveSearchAction\(state, sent\)/);
assert.match(searchUi, /failedAction == null \|\| failedAction == completeAction\(task\.id, task\.taskRevision\)/, 'Mark Done from search is the lists\' Done with its exact retry');
assert.match(model, /private fun refreshAll\(\) \{[\s\S]*?if \(search != null\) readSearch\(\)\s+\}/, 'search is read again after every command');
// Search results are core's: core's highlight segments, date line and tone, and tap target; Kotlin never sorts or filters them.
assert.doesNotMatch(code(searchUi), /\.(sort\w*|sorted\w*|groupBy|reversed|shuffled|distinct\w*)\b/);
assert.match(searchUi, /row\.getJSONArray\("titleSegments"\)\.segments\(\)/);
assert.match(searchUi, /private val SEARCH_ROUTES = mapOf\("\/inbox" to Screen\.Inbox, "\/focus" to Screen\.Focus, "\/projects-screen" to Screen\.Projects\)/);

// Process Inbox: every read and edit goes to core's session; each answer is a perform(action) with its exact request,
// written to the no-backup file before the call, re-sent after process death, and refused requests unlock.
for (const [fn, js] of [['startInboxProcessing', 'inboxStart'], ['inboxProcessingStep', 'inboxStep'], ['commitInboxProcessingStep', 'inboxCommit'],
    ['skipInboxProcessingTask', 'inboxSkip'], ['endInboxProcessing', 'inboxEnd']]) {
    assert.match(coreHost, new RegExp(`fun ${fn}\\([^)]*\\): JSONObject = callAsync\\("${js}"`), `CoreHost.${fn} reaches host method ${js}`);
}
assert.match(hostEntry, /inboxStart\(mode: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);/);
assert.match(hostEntry, /inboxStep\(json: string\): string \{\s*return submit\(async \(\) => \{\s*requireSaved\(\);\s*return unwrap\(contract\.getInboxProcessingStep\(JSON\.parse\(json\)\)\);/);
assert.match(hostEntry, /inboxCommit\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('inboxCommit', await contract\.commitInboxProcessingStep\(JSON\.parse\(json\)\)\)\);/);
assert.match(hostEntry, /inboxSkip\(json: string\): string \{\s*return submit\(async \(\) => taskResult\('inboxSkip', await contract\.skipInboxProcessingTask\(JSON\.parse\(json\)\)\)\);/);
assert.match(model, /private fun sendAnswer\(action: FailedAction, reopen: Boolean = true\) = perform\(action\) \{ runtime ->/);
assert.match(model, /val action = stepAction\(current, kind, choice\)\s+if \(busy \|\| \(failedAction != null && failedAction != action\)\) return\s+keepProcessing\(current\.copy\(pending = action, queued = null\)\)\s+sendAnswer\(action\)/,
    'the exact request is on disk before the call');
assert.match(model, /current\.pending\?\.takeIf \{ it\.kind == kind && it\.title == choice \}\s+\?: FailedAction\(kind, UUID\.randomUUID\(\)\.toString\(\), choice,/, 'a retry keeps its requestId');
assert.match(model, /keepProcessing\(restored\.copy\(hidden = true\)\)\s+failedAction = action\s+sendAnswer\(action, reopen = false\)/,
    'after process death the app lands on the Inbox; the record and its request stay on disk while they are sent again');
// The durable record goes only after core acknowledges (finishAnswer) or conclusively refuses (a stale session, an invalid request).
assert.match(model, /if \(current\.hidden\) \{ keepProcessing\(null\); return \}/);
assert.match(model, /keepProcessing\(if \(it\.hidden\) null else it\.copy\(pending = null\)\)/);
assert.match(model, /val started = if \(reopen\) InboxProcessing\.started\([^\n]*\) else null\s+acknowledged\(action\)\s+ui \{ keepProcessing\(started\)/);
assert.match(activity, /val flow = processing\?\.takeUnless \{ it\.hidden \}/);
assert.match(processUi, /\.put\("hidden", hidden\)/);
// Clearing an active chip sends core's clearedFilters for it, so a second tap changes nothing (core's clear).
assert.match(searchUi, /for \(\(label, cleared\) in view\.chips\) FilterChip\(label, label, true, true\) \{ setSearchFilters\(cleared\) \}/);
assert.match(model, /acknowledged\(action\)\s+ui \{ finishAnswer\(reply\) \}/);
assert.equal(code(model).match(/runtime\.(commitInboxProcessingStep|skipInboxProcessingTask)\(/g).length, 2);
assert.match(model, /if \(UPDATE_REFUSALS\.any \{ message\.startsWith\(it\) \}\) ui \{ failedAction = null; processing\?\.let \{ keepProcessing\(if \(it\.hidden\) null else it\.copy\(pending = null\)\) \} \}/,
    'a refused answer wrote nothing, so no request is owed');
assert.match(model, /saved\["processing"\] = value != null/);
assert.doesNotMatch(code(model), /saved\["processing"\] = (?!value != null)/, 'the Bundle holds only whether Process Inbox is open');
assert.match(model, /ProcessingStore\(File\(app\.noBackupFilesDir, "process-inbox"\)\)/);
assert.match(processUi, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(state\.toString\(\)\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
// Edits: one at a time, answered for their own session and still first in the queue; an older reply never resets newer typing.
assert.match(model, /val now = processing\?\.takeIf \{ it\.sessionId == current\.sessionId && it\.edits\.firstOrNull\(\) === next \}/);
assert.match(processUi, /LaunchedEffect\(key, coreValue, typing, pending\) \{ if \(!typing && !pending && field\.text != coreValue\)/);
assert.match(processUi, /\.onFocusChanged \{ typing = it\.isFocused \}/, 'a focused draft input keeps its typing over core replies');
// No Kotlin policy: every chip sends core's own edit; Kotlin builds only the picker's setDate, the typed text, and the disclosure.
assert.match(processUi, /DayPickerDialog\(row\?\.text\("date"\)/, 'the picker starts on core\'s date and hands core only the picked day');
assert.doesNotMatch(code(processUi), /"(inbox|next|waiting|someday|reference|done)"\s*->/, 'no status decides a Process Inbox control');
assert.match(processUi, /const val PROCESSING_MODE_KEY = "mindwtr:view:inboxProcessingMode:v1"/);
// The Inbox's Process button: core's label (99+ above 99), and TalkBack hears core's exact count as RN does; Mind Sweep takes its
// slot while the Inbox is empty (pass 11: it opens RN's Mind Sweep, as the pill beside the controls does).
assert.match(inboxUi, /view\.optJSONObject\("process"\)\?\.let \{ ProcessButton\(model, it\) \}\s+\?: view\.getJSONObject\("mindSweep"\)\.let \{ sweep ->\s+ActionButton\(Lucide\.Brain, sweep\.getString\("label"\), idle, sweep\.getString\("accessibilityLabel"\)\) \{ openMindSweep\(\) \}/);
assert.match(inboxUi, /ActionButton\(Lucide\.ListChecks, process\.getString\("label"\), writable && !busy && failedAction == null, process\.getString\("accessibilityLabel"\)\) \{ openProcessing\(\) \}/);
assert.doesNotMatch(code(activity), /"\$inbox · \$total"/, 'the "Inbox · N" count line is gone, as in RN');

// The capture popup (pass 5): core's quick capture contract, every write through perform with its exact request on disk first.
for (const [fn, js] of [['openQuickCapture', 'captureOpen'], ['quickCaptureView', 'captureView'], ['editQuickCapture', 'captureEdit'],
    ['submitQuickCapture', 'captureSubmit'], ['createQuickCaptureSnapshot', 'captureSnapshot'], ['submitQuickCaptureLines', 'captureLines'],
    ['submitQuickCapturePickerQuery', 'capturePicker']]) {
    assert.match(coreHost, new RegExp(`fun ${fn}\\([^)]*\\): JSONObject = callAsync\\("${js}"`), `CoreHost.${fn} reaches host method ${js}`);
}
for (const read of ['captureOpen(): string', 'captureView(json: string): string', 'captureEdit(json: string): string']) {
    assert.match(hostEntry, new RegExp(`${read.replace(/[()]/g, '\\$&')} \\{\\s*return submit\\(async \\(\\) => \\{\\s*requireSaved\\(\\);`), `${read} waits for an owed save`);
}
for (const [method, operation, call] of [['captureSubmit', 'quickCapture', 'submitQuickCapture'], ['captureLines', 'quickCaptureLines', 'submitQuickCaptureLines'],
    ['capturePicker', 'quickCapturePicker', 'submitQuickCapturePickerQuery']]) {
    assert.match(hostEntry, new RegExp(`${method}\\(json: string\\): string \\{\\s*return submit\\(async \\(\\) => taskResult\\('${operation}', await contract\\.${call}\\(JSON\\.parse\\(json\\)\\)\\)\\);`));
}
for (const [fn, call] of [['sendCapture', 'submitQuickCapture'], ['sendLines', 'submitQuickCaptureLines'], ['sendPicker', 'submitQuickCapturePickerQuery']]) {
    assert.match(model, new RegExp(`private fun ${fn}\\(action: FailedAction\\) = perform\\(action\\) \\{ runtime ->`), `${fn} is a perform(action)`);
    const body = model.slice(model.indexOf(`private fun ${fn}(`), model.indexOf('\n    }\n', model.indexOf(`private fun ${fn}(`)));
    assert.match(body, new RegExp(`runtime\\.${call}\\(`));
    assert.match(body, /acknowledged\(action\)/);
    assert.match(body, /if \(UPDATE_REFUSALS\.any \{ failure\.message\?\.startsWith\(it\) == true \}\)[^\n]*freeCapture\(action\)/, `${fn}: a refusal frees the ID and unlocks`);
}
assert.equal(code(model).match(/runtime\.(submitQuickCapture|submitQuickCapturePickerQuery)\(/g).length, 2);
assert.equal(code(model).match(/runtime\.submitQuickCaptureLines\(/g).length, 1);
// Each request is on disk before its call; a retry reuses the same capture UUID(s) or request UUID.
for (const [kind, fn] of [['capture', 'sendCapture'], ['captureLines', 'sendLines'], ['capturePicker', 'sendPicker']]) {
    assert.match(model, new RegExp(`current\\.pending\\?\\.takeIf \\{ it\\.kind == "${kind}" \\}`), `${kind}: a retry reuses the pending request`);
    assert.match(model, new RegExp(`keepCapture\\(current\\.copy\\(pending = action[^)]*\\)\\)\\s+${fn}\\(action\\)`), `${kind}: the request is persisted before the call`);
}
assert.match(model, /FailedAction\("capture", current\.captureId, current\.text, patch = mapOf\("options" to current\.options\.toString\(\), "openAfterSave" to "\$openAfterSave"\)\)/);
assert.match(model, /FailedAction\("captureLines", current\.lineIds\.first\(\), current\.linesText \?: current\.text,\s*patch = mapOf\("options" to current\.options\.toString\(\), "captureIds" to current\.lineIds\.joinToString\(","\)\)\)/);
assert.match(model, /failedAction = action\s+when \(action\.kind\) \{ "capture" -> sendCapture\(action\); "captureLines" -> sendLines\(action\); else -> sendPicker\(action\) \}/,
    'after process death an uncertain capture is sent again with the same IDs');
assert.match(model, /if \(action\.kind in CAPTURE_KINDS\) storedCapture\?\.let \{ keepCapture\(it\.copy\(pending = action\)\) \}/, 'a new screen reopens the popup on an owed capture, never re-sends it');
assert.match(model, /saved\["capturing"\] = value != null/);
assert.doesNotMatch(code(model), /saved\["capturing"\] = (?!value != null)|saved\["(draft|captureId|submittedTitle)"\]/, 'the Bundle holds only whether the popup is open');
assert.match(model, /CaptureStore\(File\(app\.noBackupFilesDir, "capture"\)\)/);
assert.match(captureUi, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(state\.toString\(\)\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
// Several lines: core's snapshot is written as mobile writes it (a temporary file, a clash number, the 5 newest) before the batch.
assert.match(model, /RecoverySnapshots\.write\(snapshots, it\.getString\("fileName"\), it\.getString\("contents"\)\)/);
assert.match(model, /private val snapshots = File\(app\.filesDir, "snapshots"\)/);
assert.match(snapshotsKt, /private const val MAX_SNAPSHOTS = 5/);
assert.match(snapshotsKt, /name = fileName\.removeSuffix\(SUFFIX\) \+ "\.\$clash\$SUFFIX"/);
assert.match(snapshotsKt, /FileOutputStream\(pending\)\.use \{ out -> out\.write\(contents\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(pending\.renameTo\(File\(dir, name\)\)\)/);
// No Kotlin capture policy: every chip, picker row and reset sends core's own edit; Kotlin builds only the typed note and the picked day and time.
assert.deepEqual([...new Set([...code(captureUi).matchAll(/put\("type", "(\w+)"\)/g)].map(([, type]) => type))].sort(), ['setDueDay', 'setDueTime', 'setNote']);
// The Custom date and due time pickers open on core's values (due.custom.startDay, due.time.start).
assert.match(captureUi, /DayPickerDialog\(due\.getJSONObject\("custom"\)\.getString\("startDay"\), \{ pickDay = false \}\) \{ day ->\s+editCapture\(JSONObject\(\)\.put\("type", "setDueDay"\)\.put\("day", day\)\)\s+\}/);
assert.match(captureUi, /due\.child\("time"\)\?\.getString\("start"\)/);
// In landscape the body under the header scrolls with the footer at its end, so Save stays reachable.
assert.match(captureUi, /if \(landscape\) Modifier\.weight\(1f, fill = false\)\.verticalScroll\(rememberScrollState\(\)\)\.testTag\("capture-scroll"\)/);
assert.match(captureUi, /if \(landscape\) footer\(\)\s+\}\s+if \(!landscape\) footer\(\)/);
// Durable draft (review of pass 5): an unanswered request comes back without saved state, edits are on disk before
// they are sent, and the batch sends and persists the snapshot name RecoverySnapshots wrote before the call.
assert.match(model, /storedCapture\?\.takeIf \{ saved\.get<Boolean>\("capturing"\) == true \|\| it\.pending != null \}/);
assert.match(model, /keepCapture\(current\.copy\(requests = current\.requests \+ JSONObject\(\)\.put\("edit", edit\)\)\)\n/, 'an edit is persisted before it is sent');
assert.match(captureUi, /\.put\("edits", /);
assert.match(model, /val written = taken\?\.let \{ RecoverySnapshots\.write\(snapshots, it\.getString\("fileName"\), it\.getString\("contents"\)\) \}\s+onMain \{ capture\?\.let \{ keepCapture\(it\.copy\(snapshot = written, snapshotTaken = true\)\) \} \}\s+submit\(written\)/);
assert.equal(code(model).match(/snapshotFileName/g).length, 1);
assert.match(model, /\.put\("snapshotFileName", name \?: JSONObject\.NULL\)/);
assert.match(model, /if \(!taken\) fresh\(\) else try \{ submit\(name\) \} catch \(failure: Exception\) \{\s+if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure\s+fresh\(\)/,
    'a replay sends the persisted snapshot name first; a stale one takes, persists and sends a new one with the same IDs');
// RN keeps the field focused for the next capture: a save locks (and unfocuses) the field; it takes focus back after.
assert.match(captureUi, /LaunchedEffect\(draft\.session, locked\) \{ if \(!draft\.expanded && !locked\) \{ delay\(120\); runCatching \{ titleFocus\.requestFocus\(\) \} \} \}/);
assert.match(captureUi, /const val ADD_ANOTHER_KEY = "mindwtr:quickCapture:addAnother"/);

// The Menu tab (pass 6): RN's More sheet and its lists on core's menu view contract, through the shell's command path.
// Every menu write is a perform(action) with its exact FailedAction; a failure keeps it (the banner's Try again re-sends it).
assert.match(coreHost, /fun menuRead\(name: String, json: String\): JSONObject = callAsync\("menuRead", name, json\)/);
assert.match(coreHost, /fun menuCommand\(name: String, json: String\): JSONObject = callAsync\("menuCommand", name, json\)/);
// A project's attachment command copies a picked file, which can outlast the 30 s deadline: it gets a request's deadline, on its
// first send and on the journal's replay alike, so a slow copy never stops the host (pass A2 review 1).
assert.match(coreHost, /fun deadlineOf\(method: String, args: List<Any\?>\): Long =\s*if \(method == "menuCommand" && args\.firstOrNull\(\) in ATTACHMENT_COMMANDS\) NETWORK_DEADLINE_MS else OPERATION_DEADLINE_MS/);
assert.match(coreHost, /answer\(entry\.method, entry\.args\.toTypedArray\(\), deadlineOf\(entry\.method, entry\.args\)\)/);
assert.deepEqual([.../val ATTACHMENT_COMMANDS = setOf\(([^)]*)\)/.exec(coreHost)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]),
    [.../val ATTACHMENT_KINDS = setOf\(([^)]*)\)/.exec(source('Attachments.kt'))[1].matchAll(/"(\w+)"/g)].map((m) => m[1]), 'CoreHost\'s long-deadline commands are the attachment commands');
{
    // Settings' commands (pass 10) join the Menu tab's: MENU_KINDS is its own set plus SettingsModel.kt's SETTINGS_KINDS.
    // Pass 11's commands (Bulk organize's create, Mind Sweep's Add, a saved search's Delete) close the set.
    assert.match(menuModel, /"savedSearchDelete"\) \+ SETTINGS_KINDS/);
    const kinds = [...[...new RegExp('val MENU_KINDS = setOf\\(([^)]*)\\)').exec(menuModel)[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind),
        ...[...new RegExp('val SETTINGS_KINDS = setOf\\(([^)]*)\\)').exec(source('SettingsModel.kt'))[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind)];
    const hostKinds = [...hostEntry.slice(hostEntry.indexOf('const MENU_COMMANDS'), hostEntry.indexOf('};', hostEntry.indexOf('const MENU_COMMANDS'))).matchAll(/^\s+(\w+): \((input)?\) => contract\.\w+\(\2\),$/gm)].map(([, kind]) => kind);
    // Settings › Sync's screen commands are Menu commands too, sent by SyncSettings.kt through CoreHost.syncCommand, never by send().
    const syncKinds = [.../val SYNC_COMMANDS = setOf\(([^)]*)\)/.exec(source('SyncSettings.kt'))[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind);
    // Settings › AI's screen writes too (its open, a key, a base URL), sent by AISettings.kt; its controls' setAISetting is a Settings kind.
    const aiKinds = [.../val AI_COMMANDS = setOf\(([^)]*)\)/.exec(source('AISettings.kt'))[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind);
    // Attachments' writes (pass A2), sent by Attachments.kt for the editor's draft and a project's list.
    const attachmentKinds = [.../val ATTACHMENT_KINDS = setOf\(([^)]*)\)/.exec(source('Attachments.kt'))[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind);
    // Project details' writes, sent by ProjectDetails.kt: core's prepared commits.
    const projectDetailKinds = [.../val PROJECT_DETAIL_KINDS = setOf\(([^)]*)\)/.exec(source('ProjectDetails.kt'))[1].matchAll(/"(\w+)"/g)].map(([, kind]) => kind);
    assert.deepEqual(hostKinds.sort(), [...kinds, ...syncKinds, ...aiKinds, ...attachmentKinds, ...projectDetailKinds].sort(), 'every menu command kind is one host command, logged as its operation');
    assert.match(hostEntry, new RegExp(`type MenuCommand = ${kinds.map((kind) => `'${kind}'`).join('\\s*\\| ')}\\s*\\| SyncScreenCommand \\| AIScreenCommand \\| AttachmentCommand \\| ProjectDetailCommand;`));
    assert.match(hostEntry, new RegExp(`type ProjectDetailCommand = ${projectDetailKinds.map((kind) => `'${kind}'`).join('\\s*\\| ')};`));
    assert.doesNotMatch(menuModel, new RegExp(`"(${projectDetailKinds.join('|')})"`), 'the Menu tab never sends a Project details command itself');
    // A Project details edit is the user's intent, journaled at once before anything else (CoreHost.journalAhead), then sent
    // in order when the shell is free; core's runProjectEdit reads, prepares (again after a sync) and commits it, so a death
    // at any step leaves the edit for the boot's replay (review PD 1, 2; WriteJournalTest, ProjectDetailsTest).
    {
        const details = code(source('ProjectDetails.kt'));
        assert.match(details, /private fun edit\(projectId: String\?, kind: String, fields: JSONObject\.\(\) -> Unit\) \{[\s\S]*?journalAhead\("projectEdit", json\)[\s\S]*?writes\.add\(FailedAction\("projectEdit", requestId, json\)\)/, 'an edit is journaled before it is queued');
        assert.doesNotMatch(details, /menuRead\("[^"]*Prepare"|commitPrepared/, 'Kotlin never prepares or commits an edit itself');
        assert.match(coreHost, /fun journalAhead\(name: String, json: String\) \{\s*require\(name == "projectEdit"\)[\s\S]{0,160}?\.append\("menuCommand", listOf\(name, json\)\)/);
        const journalKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournal.kt'), 'utf8');
        for (const fn of ['pending', 'append', 'settle']) assert.match(journalKt, new RegExp(`@Synchronized fun ${fn}\\(`), `the journal's ${fn} is synchronized`);
    }
    // A Details reply applies only while it answers the newest read of its kind, in the session it was read in: another
    // project or leaving the screen closes the session; a values read started before a write ended never clears a draft
    // (review PD 3; ProjectDetailsTest's ReplyGuard).
    {
        const details = code(source('ProjectDetails.kt'));
        assert.equal((details.match(/replies\.ticket\("/g) ?? []).length, 5, 'every Details read takes a ticket');
        assert.equal((details.match(/replies\.current\(ticket\)/g) ?? []).length, 5, 'every Details reply checks its ticket');
        assert.match(details, /shell\.fresh\(mine, InboxViewModel\.Part\.ProjectDetails\)/);
        assert.match(details, /fun closeOverlays\(\) \{\s*replies\.close\(\)/);
    }
    // Back (closeProject) and opening another project store the open project's typed title and notes first (review PD 1;
    // ProjectDetailsTest's editsOnLeave), as RN's end of editing and blur do on close.
    assert.match(model, /fun closeProject\(\) \{[\s\S]{0,300}?projectDetails\.follow\(null\)/, 'Back stores the typed edits');
    assert.match(code(source('ProjectDetails.kt')), /fun follow\(id: String\?\) \{\s*if \(id == projectId\) return\s*projectId\?\.let \{ old ->\s*for \(\(kind, text\) in editsOnLeave\(/, 'leaving a project stores its edits before anything resets');
    // RN's tag picker field (ProjectTagPickerModal): the keyboard's Done only ends editing; only + changes the tags (review PD 5).
    const tagField = code(source('ProjectDetails.kt')).split('BasicTextField(tagDraft')[1].split('testTag("project-tag-input")')[0];
    assert.doesNotMatch(tagField, /onDone = \{[^}]*Tag\(/, 'the tag field\'s Done changes no tag');
    // The picker's + only adds the typed tag (core's `add` intent; dd 2026-10-04): a tag already there stays. A chip toggles.
    const detailsKt = code(source('ProjectDetails.kt'));
    assert.match(detailsKt, /fun addTag\(tag: String\) \{\s*setTag\(tag, present = true\)\s*\}/, 'the picker\'s + only adds');
    assert.match(detailsKt, /edit\(projectId, "tag"\) \{ put\("tag", tag\)\.put\("present", present\) \}/);
    assert.match(detailsKt, /testTag\("project-tag-add"\)/);
    assert.match(detailsKt, /\.clickable\(role = Role\.Button\) \{ addTag\(tagDraft\); tagDraft = "" \}/, '+ adds the typed tag');
    // RN's Notes Preview shows the unsaved draft (dd 2026-10-04): the preview reads core's blocks for the draft text, and
    // switching to Preview stores nothing; leaving the field for the preview stores nothing either.
    assert.match(detailsKt, /menuRead\("projectNotesPreview", /, 'the preview reads core\'s blocks for the draft');
    assert.doesNotMatch(detailsKt, /projectNotesView/, 'the preview never reads the stored notes in place of the draft');
    const previewToggles = detailsKt.match(/\{ [^{}]*(notesPreview = !notesPreview|editing = !editing)[^{}]*\}/g) ?? [];
    assert.equal(previewToggles.length, 2, 'the inline and the full-screen Preview switches parsed');
    for (const toggle of previewToggles) {
        assert.doesNotMatch(toggle, /commitNotes/, 'switching to Preview stores nothing');
    }
    // RN's field sets autoCorrect={false} and autoCapitalize="none" (review PD 6).
    assert.match(tagField, /KeyboardOptions\(capitalization = KeyboardCapitalization\.None, autoCorrectEnabled = false,/, 'the tag field neither corrects nor capitalizes');
    assert.match(hostEntry, new RegExp(`type AttachmentCommand = ${attachmentKinds.map((kind) => `'${kind}'`).join('\\s*\\| ')};`));
    assert.doesNotMatch(menuModel, new RegExp(`"(${attachmentKinds.join('|')})"`), 'the Menu tab never sends an attachment command itself');
    assert.match(hostEntry, new RegExp(`type SyncScreenCommand = ${syncKinds.map((kind) => `'${kind}'`).join('\\s*\\| ')};`));
    assert.match(hostEntry, new RegExp(`type AIScreenCommand = ${aiKinds.map((kind) => `'${kind}'`).join('\\s*\\| ')};`));
    assert.doesNotMatch(menuModel, new RegExp(`"(${[...syncKinds, ...aiKinds].join('|')})"`), 'the Menu tab never sends a Sync or AI screen command itself');
    assert.match(hostEntry, /menuCommand\(name: string, json: string\): string \{\s*return submit\(async \(\) => \{\s*const command = MENU_COMMANDS\[name as MenuCommand\];[\s\S]{0,120}?return taskResult\(name as MenuCommand, await command\(JSON\.parse\(json\) as never\)\);/);
    assert.match(hostEntry, /menuRead\(name: string, json: string\): string \{\s*return submit\(async \(\) => \{[\s\S]{0,300}?if \(name !== 'more'\) requireSaved\(\);\s*const read = MENU_READS\[name\];[\s\S]{0,100}?return unwrap\(read\(JSON\.parse\(json\) as never\)\);/);
    const input = code(menuModel.slice(menuModel.indexOf('private fun input(action: FailedAction)'), menuModel.indexOf('}.toString()', menuModel.indexOf('private fun input('))));
    // The list actions (Archive, Contexts, Trash, Review, and the Review's project Add task) are core's action with its request UUID.
    const LIST_KINDS = ['archiveAction', 'contextsAction', 'trashAction', 'reviewAction', 'reviewTask'];
    for (const kind of kinds.filter((kind) => !LIST_KINDS.includes(kind))) assert.match(input, new RegExp(`"${kind}"(, "\\w+")* ->`), `input() builds the ${kind} request`);
    for (const kind of LIST_KINDS) assert(kinds.includes(kind), `MENU_KINDS has ${kind}`);
    assert.doesNotMatch(input, new RegExp(`"(${LIST_KINDS.join('|')})" ->`), 'no list action has a request of its own shape');
    assert.match(input, /else -> JSONObject\(\)\.put\("requestId", action\.id\)\.put\("action", JSONObject\(action\.title\)\)/, 'a list action is core\'s action with its request UUID');
}
assert.match(menuModel, /private fun send\(action: FailedAction\) = shell\.perform\(action\) \{ runtime ->\s+val reply = try \{\s+runtime\.menuCommand\(action\.kind, input\(action\)\)[\s\S]{0,2000}?shell\.acknowledged\(action\)/, 'menu writes run through perform with their exact FailedAction');
assert.match(menuModel, /if \(refused && action\.kind == "focusSave"\) shell\.ui \{ focusControls\.refused\(action\) \}/, 'a refused saved filter frees its request UUID');
assert.match(menuModel, /if \(refused && action\.kind == "calendarCreate"\) shell\.ui \{ calendar\.refused\(action\) \}/, 'a refused composer Save frees its request UUID');
assert.equal(code(menuModel).match(/runtime\.menuCommand\(/g).length, 1, 'send is the one menu write');
assert.equal(code(menuModel).match(/shell\.perform\(action\)/g).length, 1);
assert.match(menuModel, /fun retry\(action: FailedAction\) = send\(action\)/);
assert.match(model, /else -> menu\.retry\(action\)\s+\}\s+\}/, 'retryOwed hands every menu kind to its exact re-send');
for (const [name, text] of Object.entries(menuScreens)) {
    assert.doesNotMatch(code(text).replace(/^import .*$/gm, ''), /runtime\.|menuCommand\(|menuRead\(/, `${name}: screens reach core only through MenuModel`);
}
// A Someday create's exact request (a capture UUID, or a section title core finds again) is on disk, synced, before the call;
// after process death it is sent before anything else, even without saved state; it goes only after core answers.
assert.match(menuModel, /fun saveCreate\(\) \{\s+val action = createAction\(\) \?: return\s+if \(shell\.busy \|\| \(shell\.failedAction != null && shell\.failedAction != action\)\) return\s+store\.write\(action\)\s+send\(action\)/);
assert.match(menuModel, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(state\.toString\(\)\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
assert.match(model, /val menu = MenuModel\(this, saved, prefs, File\(app\.noBackupFilesDir, "menu"\)\)/);
assert.match(menuModel, /store\.read\(\)\?\.let \{ pending ->\s+if \(shell\.failedAction == null\) \{\s+shell\.owe\(pending\)\s+send\(pending\)/);
assert.match(model, /if \(reopenCapture != null\) resumeCapture\(reopenCapture\) else captureStore\.delete\(\)\s+\/\/[^\n]*\s+menu\.start\(sheet\)/);
assert.match(menuModel, /if \(refused && action\.kind in CREATES\) shell\.ui \{ store\.delete\(\) \}/, 'a refused create wrote nothing: its record goes');
assert.match(menuModel, /shell\.acknowledged\(action\)\s+shell\.ui \{\s+if \(action\.kind in CREATES\) store\.delete\(\)/, 'an acknowledged create\'s record goes');
assert.equal(code(menuModel).match(/store\.delete\(\)/g).length, 2, 'only an answer from core removes a pending create');
assert.match(menuModel, /"addTask" -> FailedAction\("somedayTask", open\.getString\("captureId"\), text,/, 'Add task sends its capture UUID, kept with its dialog');
// Reads: background refreshes and user reads, with the shell's per-list freshness; paging stays under one revision and a stale
// window reads the list again from its first window (not an error).
assert.match(menuModel, /shell\.background\(listOf\(Part\.Menu\), \{ runtime -> read\(runtime, list, params, depth, deep, bulk = bulk\) \}\) \{ next, mine ->\s+if \(shell\.fresh\(mine, Part\.Menu\)\) show\(list, next\)/);
assert.match(menuModel, /shell\.ui \{ if \(shell\.fresh\(mine, Part\.Menu\)\) show\(list, next\) \}/);
assert.match(menuModel, /\.put\("offset", page\.items\.size\)\.put\("limit", PAGE\)\.put\("revision", page\.revision\)/, 'later windows carry the view\'s revision');
assert.match(menuModel, /runtime\.menuRead\("collection", JSONObject\(\)\.put\("view", list\)\.put\("collection", name\)\.put\("params", page\.params\)/, 'collections page through getMenuViewCollection with the accepted params');
// The Inbox's and Archive's filter tokens page through their own reads (getInboxFilterTokens, getArchiveFilterTokens), with the
// accepted params and the view's revision; a picker search (query) reads the matches from offset zero.
assert.match(menuModel, /"inbox", "archive" -> runtime\.menuRead\(if \(list == "inbox"\) "inboxTokens" else "archiveTokens", JSONObject\(\)\.put\("params", page\.params\)\s+\.put\("offset", offset\)\.put\("limit", WINDOW\)\.put\("revision", page\.revision\)\.apply \{ query\?\.let \{ put\("query", it\) \} \}/);
assert.equal(code(menuModel).match(/if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure/g).length, 5,
    'read, More, a collection\'s More, the move dialog\'s choices and a picker search treat a stale window as a reread, never an error');
assert.match(menuModel, /private fun readMoveChoices\(depth: Int = WINDOW\) \{[\s\S]*?\.put\("offset", 0\)[\s\S]*?\.put\("revision", first\.getString\("revision"\)\)[\s\S]*?if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure/,
    'the move dialog pages its choices under the first window\'s revision and rereads from the first window');
assert.match(menuModel, /fun moreMoveChoices\(\) \{ moveChoices\?\.getJSONObject\("choices"\)\?\.getJSONArray\("items"\)\?\.length\(\)\?\.let \{ readMoveChoices\(it \+ WINDOW\) \} \}/);
assert.match(model, /private fun refreshAll\(\) \{\s+val at = depth\(\)\s+background\(Part\.entries, \{ runtime -> read\(runtime, at\) \}, ::showLists\)\s+menu\.refresh\(\)/, 'the open Menu list is read again after every command');
// Filters, sorts and groups: every choice sends the exact edit or value core put on it; only typed text builds an edit.
{
    // Kotlin names only core's Archive and bulk actions (NativeArchiveAction, NativeBulkAction), the typed text's edits (a filter's
    // setSearch or setLocation through its `type` variable, Bulk Organize's setText), and nothing else.
    const bulkSource = readFileSync(resolve(app, '../../packages/core/src/native-host-contract-bulk-actions.ts'), 'utf8');
    const unionOf = (text, type) => [...(new RegExp(`export type ${type} =([\\s\\S]*?);\\n`).exec(text)?.[1] ?? '').matchAll(/type: '(\w+)'/g)].map(([, name]) => name);
    const allowed = new Set([...unionOf(contractSource, 'NativeArchiveAction'), ...unionOf(bulkSource, 'NativeBulkAction'), 'setSearch', 'setText', 'type']);
    assert(allowed.has('setCompletedAt') && allowed.has('organize') && allowed.has('restoreTasks'), 'core\'s action unions were read');
    const used = new Set([...code(menuModel + menuUi + archiveUi + bulkUi).matchAll(/put\("type", "?(\w+)/g)].map(([, type]) => type));
    for (const type of used) assert(allowed.has(type), `${type} is one of core's Archive or bulk actions, or typed text's edit`);
    assert(['setCompletedAt', 'moveTasks', 'editTaskTokens', 'organize', 'trashTasks'].every((type) => used.has(type)));
}
assert.match(menuModel, /reload\(JSONObject\(\)\.put\("type", type\)\.put\("value", text\)\)/);
assert.match(menuUi, /filterEdit\(option\.getJSONObject\("edit"\)\)/);
assert.match(menuUi, /filterEdit\(filters\.getJSONObject\("clearEdit"\)\)/);
assert.match(menuUi, /removeChip\(chip\.getJSONObject\("action"\)\)/);
// No Kotlin policy in the new files: core's items, headings, collections and options are walked as sent.
for (const [name, text] of Object.entries({ menuModel, ...menuScreens })) {
    assert.doesNotMatch(code(text), /\.(sort\w*|sorted\w*|filter(?!Bg\b|Edit\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/, `${name}: no Kotlin sorting, filtering, or grouping (filterEdit sends core's edit)`);
    // The date APIs, not a calendar icon or heading (Lucide.Calendar, the reviews' calendar cards).
    assert.doesNotMatch(code(text), /SimpleDateFormat|DateTimeFormatter|LocalDate|java\.time|java\.util\.Calendar|Calendar\.getInstance|GregorianCalendar|Instant\b|\.format\(|toLocal/, `${name}: no Kotlin date formatting or parsing`);
    assert.doesNotMatch(code(text), new RegExp(`${STATUS}(?:\\s*,\\s*${STATUS})*\\s*->\\s*${STATUS}`), `${name}: no status-to-status map`);
}
// The More sheet: core's destinations (getMoreMenu); a tile this app builds opens, the others are drawn disabled, never a dead tap.
// One accessibility node holds the label, the role and the state, so TalkBack hears an unbuilt tile as disabled.
assert.equal(moreUi.match(/\.clearAndSetSemantics \{\s+contentDescription = label; role = Role\.Button\s+if \(enabled\) onClick \{ model\.menu\.openTile\(id\); true \} else disabled\(\)\s+\}\s+\.clickable\(enabled = enabled\) \{ model\.menu\.openTile\(id\) \}/g)?.length, 2, "an unbuilt tile is disabled and dimmed on its labelled node; a built one is dimmed only while a command runs or a retry is owed");
assert.equal(moreUi.match(/\.fade\(if \(enabled\) 1f else 0\.45f\)/g)?.length, 2, 'both tile kinds dim at 45% while disabled');
assert.match(menuModel, /fun opens\(id: String\) = id in setOf\("waiting", "someday", "reference", "history", "projects", "review", "contexts", "trash", "calendar", "board", "settings"\)/);
assert.match(activity, /if \(menu\.sheet\) MoreSheet\(model\)/);
assert.match(activity, /else if \(listed != null && writable\) MenuScreenHost\(model, listed\)/);
// Navigation survives rotation (the model is held by the ViewModel) and process death (the Bundle): the sheet, screen, tab, dialog, session.
for (const key of ['menuSheet', 'menuScreen', 'historyTab', 'menuState', 'menuDialog', 'quickAccess', 'reviewFrom']) assert.match(menuModel, new RegExp(`saved(\\.get<\\w+>\\("${key}"\\)|\\["${key}"\\])`), `${key} rides the Bundle`);
assert.match(menuUi, /BackHandler\(enabled = failedAction == null\) \{ if \(menu\.dialog != null\) menu\.backInDialog\(\) else if \(menu\.page\?\.bulk != null\) menu\.list\?\.let\(menu::endBulk\) else menu\.closeScreen\(\) \}/);
// Search results for the Menu lists open them (review ruling 5 of pass 4).
assert.match(searchUi, /listed != null -> \{ closeSearch\(\); menu\.openRoute\(listed\); highlight\(task\.id\) \}/);
assert.match(menuModel, /"\/waiting" to \(MenuScreen\.Waiting to null\), "\/someday" to \(MenuScreen\.Someday to null\),\s+"\/reference" to \(MenuScreen\.Reference to null\), "\/done" to \(MenuScreen\.History to "done"\), "\/archived" to \(MenuScreen\.History to "archived"\)/);
// RN's device view state: Done and Archived under RN's keys, folded groups under RN's per-list key.
assert.match(viewStateKt, /const val DONE_VIEW_KEY = "mindwtr:view:done:v1"/);
assert.match(viewStateKt, /const val ARCHIVED_VIEW_KEY = "mindwtr:view:archived:v1"/);
assert.match(viewStateKt, /private fun key\(list: String\) = "mindwtr:view:group-collapse:\$list:v1"/);

// Pass 7: Contexts, Trash, Review, and the Weekly and Daily Review, on core's list views and review views.
// Reads pass Kotlin's input to core unchanged; every write is core's action through MenuModel.act -> send -> perform(action).
for (const [name, method] of [['contexts', 'getContextsView'], ['trash', 'getTrashView'], ['review', 'getReviewOverview'], ['weekly', 'getWeeklyReview'],
    ['weeklyList', 'getWeeklyReviewList'], ['daily', 'getDailyReview']]) {
    assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuRead ${name} is core's ${method}`);
}
for (const [name, method] of [['contextsAction', 'runContextsAction'], ['trashAction', 'runTrashAction'], ['reviewAction', 'runReviewAction'], ['reviewTask', 'runReviewAction']]) {
    assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuCommand ${name} is core's ${method}`);
}
assert.match(menuModel, /internal fun act\(kind: String, action: JSONObject\) = send\(FailedAction\(kind, UUID\.randomUUID\(\)\.toString\(\), action\.toString\(\)\)\)/,
    'a list action is one command with a new request UUID; the action itself is its exact retry');
for (const [name, text] of Object.entries(reviewScreens)) {
    assert.doesNotMatch(code(text), /\bsend\(|shell\.perform|FailedAction\(/, `${name}: writes go through MenuModel.act or saveCreate, never around perform`);
}
// Kotlin names only core's action types (NativeContextsAction, NativeTrashAction, NativeReviewAction) and Review's expansion edits.
{
    const reviewSource = readFileSync(resolve(app, '../../packages/core/src/native-host-contract-review-views.ts'), 'utf8');
    const union = (text, type) => [...(new RegExp(`export type ${type} =([\\s\\S]*?);\\n`).exec(text)?.[1] ?? '').matchAll(/type: '(\w+)'/g)].map(([, name]) => name);
    const allowed = new Set([...union(contractSource, 'NativeContextsAction'), ...union(contractSource, 'NativeTrashAction'),
        ...union(reviewSource, 'NativeReviewAction'), ...union(reviewSource, 'NativeReviewExpansionEdit')]);
    assert(allowed.has('emptyTrash') && allowed.has('addProjectTask') && allowed.has('toggleArea'), 'core\'s action unions were read');
    const used = new Set([...code(Object.values(reviewScreens).join('\n')).matchAll(/put\("type", "(\w+)"\)/g)].map(([, type]) => type));
    assert(used.size > 0);
    for (const type of used) assert(allowed.has(type), `${type} is one of core's list actions or expansion edits`);
    assert.doesNotMatch(code(Object.values(reviewScreens).join('\n')), /put\("type", [^"]/, 'no action type is built from a variable');
}
// Destructive actions stay as safe as RN: delete forever, the selection's delete forever, and Clear Trash only after core's question;
// Clear Trash sends the revision its question showed (core refuses a stale one).
for (const call of ['purgeItem(kind, id, revision)', 'purgeItems(view.getJSONObject("selected"))', 'emptyTrash(clear.getString("revision"))']) {
    const at = trashUi.indexOf(call);
    assert(at > 0 && trashUi.slice(Math.max(0, at - 160), at).includes('confirm('), `Trash sends ${call} only from core's confirmation`);
}
assert.equal(code(trashUi).match(/\b(purgeItem|purgeItems|emptyTrash)\(/g).length, 3, 'Trash builds each destructive action once, inside its confirmation');
assert.match(menuUi, /confirmButton = \{ TextButton\(onClick = \{ keepDialog\(null\); act\(open\.optString\("command", "archiveAction"\), open\.getJSONObject\("action"\)\) \}, enabled = idle\)/);
// Bulk trash (Contexts, Review) asks core's question first too; a row's trash is the recoverable move with core's Undo, as in RN.
assert.match(contextsUi, /confirm\(bulk\.getJSONObject\("deleteConfirmation"\), trashTasks\(selected, revisions\), "contextsAction"\)/);
assert.match(reviewUi, /"delete" -> confirm\(bulk\.getJSONObject\("deleteConfirmation"\), trashTasks\(selected, bulk\.getJSONObject\("taskRevisions"\)\), "reviewAction"\)/);
// Every Contexts, Trash and Review action that writes existing rows carries the revision core's view showed: a row's taskRevision,
// the view's taskRevisions for the selection (Contexts' top-level, Review's bar's), Trash's item revision and selection revisions.
for (const [helper, revision] of [['setTaskStatus', 'taskRevision'], ['trashTask', 'taskRevision'], ['trashTasks', 'taskRevisions'], ['moveTasks', 'taskRevisions'],
    ['editTaskTokens', 'taskRevisions'], ['restoreItem', 'revision'], ['purgeItem', 'revision'], ['addTag', 'taskRevisions'], ['removeTags', 'taskRevisions'],
    ['markReviewedTasks', 'taskRevisions'], ['organizeTasks', 'taskRevisions'], ['followUpToday', 'taskRevision']]) {
    const at = listActionsKt.indexOf(`internal fun ${helper}(`);
    const body = listActionsKt.slice(at, listActionsKt.slice(at + 1).search(/\n(internal|private) fun |\n\/\*\*/) + at + 1);
    assert.match(body, new RegExp(`\\.put\\("${revision}", ${revision}\\)`), `${helper} sends its ${revision}`);
}
assert.match(listActionsKt, /\.put\("taskRevisions", selected\.getJSONObject\("taskRevisions"\)\)\.put\("projectRevisions", selected\.getJSONObject\("projectRevisions"\)\)/);
for (const text of [contextsUi, reviewUi, weeklyUi, dailyUi]) {
    assert.doesNotMatch(code(text), /setTaskStatus\(row\.id, status\)|trashTask\(row\.id\)/, 'a row action sends the row\'s taskRevision');
}
// The status menu on a list whose contract writes its rows sends that list's setTaskStatus; elsewhere it keeps updateTask.
assert.match(rowUi, /\.clickable\(enabled = enabled, role = Role\.Button\) \{ if \(!menu\.rowStatus\(task, status\)\) changeStatus\(task, status\) \}/);
assert.match(menuModel, /private val ROW_KINDS = mapOf\("contexts" to "contextsAction", "review" to "reviewAction", "weekly" to "reviewAction", "daily" to "reviewAction"\)/);
// The Weekly Review's project Add task creates a task: its exact request (the request UUID core makes the task's id) is on disk first.
assert.match(menuModel, /private val CREATES = setOf\("somedayTask", "somedaySection", "reviewTask", "calendarCreate", "boardCreate", "focusSave", "manageEditor", "bulkCreate", "mindSweepAdd"\)/);
assert.match(menuModel, /"projectTask" -> FailedAction\("reviewTask", open\.getString\("requestId"\), addProjectTask\(open\.getString\("projectId"\), open\.optString\("text"\)\)\.toString\(\)\)/);
// The menu inputs send core's revisions (crash-safe writes): a parked project's projectRevision with Activate, the moved tasks'
// revisions with a Someday move (a row's, or the bulk bar's moveToSection.taskRevisions), and a new section its request UUID.
assert.match(menuModel, /"activateProject" -> JSONObject\(\)\.put\("projectId", action\.id\)\.put\("projectRevision", action\.patch\["projectRevision"\]\)/);
assert.match(menuModel, /\.put\("sectionId", action\.patch\["sectionId"\] \?: JSONObject\.NULL\)\.put\("taskRevisions", JSONObject\(action\.patch\["taskRevisions"\] \?: "\{\}"\)\)/);
assert.match(menuModel, /"somedaySection" -> JSONObject\(\)\.put\("title", action\.title\)\.put\("requestId", action\.id\)/);
assert.match(menuUi, /val revision = project\.optString\("projectRevision"\)[\s\S]*?menu\.activate\(id, revision\)/);
assert.match(rowUi, /menu\.openMove\(listOf\(task\.id\), JSONObject\(\)\.put\(task\.id, task\.taskRevision\)\)/);
assert.match(bulkUi, /openMove\(it\.getJSONArray\("taskIds"\)\.ids\(\), it\.getJSONObject\("taskRevisions"\)\)/);
assert.match(rowUi, /setTaskFocus\(task\.id, target, task\.taskRevision\)/);
assert.match(searchUi, /complete\(task\.id, task\.taskRevision\)/);
assert.equal(code(weeklyUi).match(/saveCreate\(\)/g).length, 3, 'Return, Save & edit and Add all send the one persisted request');
// A review's place is core's checkpoint, stored under core's key (RN's session keys) and sent back; Finish deletes it.
{
    const reviewModelSource = readFileSync(resolve(app, '../../packages/core/src/review-views-model.ts'), 'utf8');
    for (const [kotlin, core] of [['WEEKLY_REVIEW_KEY', 'WEEKLY_REVIEW_SESSION_STORAGE_KEY'], ['DAILY_REVIEW_KEY', 'DAILY_REVIEW_SESSION_STORAGE_KEY']]) {
        const value = new RegExp(`export const ${core} = '([^']+)'`).exec(reviewModelSource)[1];
        assert.match(viewStateKt, new RegExp(`const val ${kotlin} = "${value}"`), `${kotlin} is core's ${core}`);
    }
}
assert.match(menuModel, /if \(list == "weekly" \|\| list == "daily"\) prefs\.edit\(\)\.putString\(next\.view\.getString\("storageKey"\), next\.view\.getString\("checkpoint"\)\)\.apply\(\)/);
assert.match(weeklyUi, /prefs\.edit\(\)\.remove\(view\.getString\("storageKey"\)\)\.apply\(\)/);
// Paging stays under the view's revision: the Weekly Review's nested lists page through getWeeklyReviewList with the view's own inputs.
assert.match(menuModel, /runtime\.menuRead\("weeklyList", JSONObject\(page\.params\.toString\(\)\)\.put\("list", name\.substringBefore\(':'\)\)[\s\S]{0,160}?\.put\("revision", page\.revision\)/);
// RN's quick-access tab: core's quickAccessView; Review, Contexts and the Calendar (pass 8) are built, anything else shows Projects.
assert.match(menuModel, /val quickView: String get\(\) = quickAccess\?\.takeIf \{ it == "review" \|\| it == "contexts" \|\| it == "calendar" \} \?: "projects"/);
assert.match(activity, /TabItem\(model, Screen\.Projects, when \(quick\) \{ "review" -> Lucide\.ClipboardCheck; "contexts" -> Lucide\.Circle; "calendar" -> Lucide\.Calendar; else -> Lucide\.Folder \}, model\.menu\.quickLabel\)/);
assert.match(model, /val sheet = runCatching \{ menu\.readSheet\(runtime\) \}\.getOrNull\(\)/, 'the quick-access view is read on the boot thread, before the first frame');

// Pass 8: the Calendar and the Board, on core's calendar and Board contracts.
{
    const calendarModel = source('CalendarModel.kt');
    const calendarUi = source('CalendarScreen.kt');
    const boardModel = source('BoardModel.kt');
    const boardUi = source('BoardScreen.kt');
    const pass8 = { calendarModel, calendarUi, boardModel, boardUi };
    // Reads pass Kotlin's input to core unchanged (the composer's open and edit write nothing); writes are core's actions.
    for (const [name, method] of [['calendar', 'getCalendarView'], ['calendarSheet', 'getCalendarItemSheet'], ['calendarComposer', 'openCalendarComposer'],
        ['calendarEdit', 'editCalendarComposer'], ['board', 'getBoardView'], ['boardList', 'getBoardList']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuRead ${name} is core's ${method}`);
    }
    for (const [name, method] of [['calendarAction', 'runCalendarAction'], ['calendarCreate', 'runCalendarAction'], ['boardAction', 'runBoardAction'], ['boardCreate', 'runBoardAction']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuCommand ${name} is core's ${method}`);
    }
    // Every write is MenuModel's send -> perform(action) with its exact FailedAction: an action through command (a new request UUID,
    // core's whole input its exact retry), a create (the composer's Save, Duplicate) through create, on disk (synced) before the call.
    assert.match(menuModel, /internal fun command\(kind: String, input: JSONObject\) = send\(FailedAction\(kind, UUID\.randomUUID\(\)\.toString\(\), input\.toString\(\)\)\)/);
    assert.match(menuModel, /internal fun create\(action: FailedAction\) \{\s+if \(shell\.busy \|\| \(shell\.failedAction != null && shell\.failedAction != action\)\) return\s+store\.write\(action\)\s+send\(action\)/);
    assert.match(menuModel, /"calendarAction", "calendarCreate", "boardAction", "boardCreate" -> JSONObject\(action\.title\)\.put\("requestId", action\.id\)/);
    assert.match(menuModel, /"calendarAction", "calendarCreate" -> calendar\.done\(action, reply\)\s+"boardAction", "boardCreate" -> board\.done\(action, reply\)/);
    assert.match(calendarModel, /private fun act\(action: JSONObject\) = menu\.command\("calendarAction", JSONObject\(\)\.put\("action", action\)/);
    assert.match(calendarModel, /private fun saveAction\(draft: ComposerDraft\) = FailedAction\("calendarCreate", draft\.requestId, /, 'a composer Save keeps its request UUID (core makes it the new task\'s id)');
    assert.match(calendarModel, /owed\(draft\)\?\.let \{ return menu\.create\(it\) \}[\s\S]{0,200}?menu\.create\(saveAction\(draft\)\)/, 'Save re-sends the owed request, else the composer\'s own');
    assert.match(boardModel, /fun duplicate\(taskId: String\) = menu\.create\(FailedAction\("boardCreate", UUID\.randomUUID\(\)\.toString\(\),/, 'Duplicate\'s request UUID is the copy\'s id, on disk first');
    assert.equal(code(calendarModel).match(/menu\.command\(/g).length, 1, 'the Calendar writes through act');
    assert.equal(code(boardModel).match(/menu\.command\(/g).length, 2, 'the Board writes moveCard and trashTask through command');
    for (const [name, text] of Object.entries({ calendarUi, boardUi })) {
        assert.doesNotMatch(code(text).replace(/^import .*$/gm, ''), /runtime\.|menuCommand\(|menuRead\(|\bsend\(|shell\.perform|FailedAction\(|menu\.command|menu\.create/, `${name}: the screen reaches core only through its model`);
    }
    for (const [name, text] of Object.entries({ calendarModel, boardModel })) {
        assert.doesNotMatch(code(text), /menuCommand\(|\bsend\(|shell\.perform\(action|\.perform\([A-Za-z]/, `${name}: writes only through MenuModel.command or create`);
    }
    // Kotlin names only core's actions and edits: NativeCalendarAction, NativeCalendarComposerEdit, NativeBoardAction and BoardFilterEdit.
    const calendarSource = readFileSync(resolve(app, '../../packages/core/src/native-host-contract-calendar.ts'), 'utf8');
    const boardSource = readFileSync(resolve(app, '../../packages/core/src/native-host-contract-board.ts'), 'utf8');
    const boardViewSource = readFileSync(resolve(app, '../../packages/core/src/board-view-model.ts'), 'utf8');
    const union = (text, type) => [...(new RegExp(`export type ${type} =([\\s\\S]*?);\\n`).exec(text)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(([, name]) => name);
    const allowed = new Set([...union(calendarSource, 'NativeCalendarAction'), ...union(calendarSource, 'NativeCalendarComposerEdit'),
        ...union(boardSource, 'NativeBoardAction'), ...union(boardViewSource, 'BoardFilterEdit')]);
    for (const name of ['moveTask', 'saveComposer', 'selectTask', 'startTime', 'moveCard', 'duplicateTask', 'toggleDuePreset', 'setMatchMode']) assert(allowed.has(name), `core's unions were read (${name})`);
    const typed = [...code(Object.values(pass8).join('\n')).matchAll(/put\("type", (?:if \([^)]*\) )?"(\w+)"(?: else "(\w+)")?\)/g)].flatMap(([, a, b]) => [a, b].filter(Boolean));
    assert(typed.length > 10);
    for (const type of typed) assert(allowed.has(type), `${type} is one of core's calendar or Board actions or edits`);
    assert.doesNotMatch(code(Object.values(pass8).join('\n')), /put\("type", (?!if \()[^"]/, 'no action or edit type is built from a variable');
    // Paging under one revision; STALE_REVISION reads again from the first window (once), never an error.
    assert.match(calendarModel, /\.put\("offset", items\.length\(\)\)\.put\("limit", WINDOW\)\s*\.put\("revision", first\.getString\("revision"\)\)/);
    assert.match(calendarModel, /if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure\s+if \(again\) return read\(runtime, sent, sentQuery, again = false\)/);
    assert.match(boardModel, /\.put\("revision", shown\.revision\)/);
    assert.match(boardModel, /if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure\s+if \(again\) return read\(runtime, view\.getJSONObject\("filters"\), null, depth, again = false\)/);
    // A calendar changes with the clock: read again each minute while it shows, and on resume (the screen hosts' refresh).
    assert.match(calendarUi, /owner\.repeatOnLifecycle\(Lifecycle\.State\.RESUMED\) \{ while \(true\) \{ delay\(60_000\); refresh\(\) \} \}/);
    assert.match(menuModel, /if \(list == "calendar"\) return calendar\.refresh\(\)\s+if \(list == "board"\) return board\.refresh\(\)/);
    // Navigation state rides the Bundle: the Calendar's place, search, sheet and composer draft; the Board's filters, search and sheet.
    for (const key of ['calendarState', 'calendarQuery', 'calendarSheet', 'calendarComposer']) assert.match(calendarModel, new RegExp(`saved(\\.get<\\w+>\\("${key}"\\)|\\["${key}"\\])`), `${key} rides the Bundle`);
    for (const key of ['boardFilters', 'boardSearch', 'boardSheet']) assert.match(boardModel, new RegExp(`saved(\\.get<\\w+>\\("${key}"\\)|\\["${key}"\\])`), `${key} rides the Bundle`);
    // No Kotlin task policy, sorting, filtering, date math or date formatting in the new files.
    for (const [name, text] of Object.entries(pass8)) {
        // Deadline labels consume core's precomputed group identity and first-row
        // index. These two exact rendering partitions do not decide which tasks
        // are visible, their order, dates, or grouping policy. Every other filter
        // call remains forbidden, including any changed predicate here.
        let policyCode = code(text);
        if (name === 'calendarUi') {
            for (const renderingPartition of [
                'markers.filter { it.getJSONObject("deadline").getInt("groupIndex") == 0 }',
                'markers.filter { it.getJSONObject("deadline").getString("groupId") == geometry.getString("groupId") }',
            ]) {
                assert.equal(policyCode.split(renderingPartition).length - 1, 1, 'one exact core-owned deadline rendering partition');
                policyCode = policyCode.replace(renderingPartition, 'coreProvidedDeadlineRows');
            }
        }
        // `.filters` is core's filter state (the Board view's), not a filtering call.
        assert.doesNotMatch(policyCode, /\.(sort\w*|sorted\w*|filter(?!Bg\b|Edit\b|s\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/, `${name}: no Kotlin sorting, filtering, or grouping`);
        assert.doesNotMatch(code(text), /SimpleDateFormat|DateTimeFormatter|LocalDate|LocalTime|java\.time|java\.util\.Calendar|Calendar\.getInstance|GregorianCalendar|Instant\b|\.format\(|toLocal|currentTimeMillis|\bDate\(|TimeZone/, `${name}: no Kotlin date math, formatting or parsing`);
        assert.doesNotMatch(code(text), new RegExp(`${STATUS}(?:\\s*,\\s*${STATUS})*\\s*->\\s*${STATUS}`), `${name}: no status-to-status map`);
    }
    // Kotlin turns a finger's place into core's grid cell only: core's minutes (snapped to core's step), core's day keys, core's extent.
    const calendarModelSource = readFileSync(resolve(app, '../../packages/core/src/calendar-view-model.ts'), 'utf8');
    for (const [kotlin, core] of [['SNAP_MINUTES', 'CALENDAR_SNAP_MINUTES'], ['TAP_MINUTES', 'CALENDAR_TAP_DURATION_MINUTES']]) {
        const value = new RegExp(`export const ${core} = (\\d+);`).exec(calendarModelSource)[1];
        assert.match(calendarUi, new RegExp(`internal const val ${kotlin} = ${value}\\n`), `${kotlin} is core's ${core}`);
    }
    assert.match(calendarUi, /private fun JSONObject\.extentMinutes\(\): Int = \(getJSONArray\("hourLabels"\)\.length\(\) - 1\) \* 60/, 'the grid\'s extent is core\'s hour labels');
    // A drop sends exactly one core action: a Calendar block's moveTask; a Board card's moveCard with the moved card's id (a position only inside its column).
    assert.equal(code(calendarUi).match(/calendar\.move\(/g).length, 1);
    assert.match(calendarModel, /if \(startMinutes == timed\.getInt\("startMinutes"\)\) return/, 'a block let go where it was sends nothing');
    assert.equal(code(boardUi).match(/board\.move\(/g).length, 3, 'a drop into another column, a drop inside its own, and TalkBack\'s Move to');
    assert.match(boardUi, /if \(after != before\) board\.move\(id, revision, status, after, sameColumn = true\)/, 'a drop that changes nothing sends nothing');
    // A card's move and Delete, and the Calendar's move, Done, Remove from calendar and Delete, carry the task's revision as core's
    // view showed it (the card's and the item's row.taskRevision, the sheet's taskRevision); the composer is echoed as core built it.
    assert.match(boardUi, /val revision = row\.optString\("taskRevision"\)/);
    assert.match(boardModel, /\.put\("type", "moveCard"\)[^\n]*\.put\("taskRevision", taskRevision\)/);
    assert.match(boardModel, /\.put\("type", "trashTask"\)\.put\("taskId", taskId\)\.put\("taskRevision", taskRevision\)/);
    for (const type of ['completeTask', 'moveTask', 'unscheduleTask', 'deleteTask']) {
        const at = calendarModel.indexOf(`.put("type", "${type}")`);
        assert(at > 0 && /\.put\("taskRevision", /.test(calendarModel.slice(at, calendarModel.indexOf('\n', calendarModel.indexOf('\n', at) + 1))), `the Calendar's ${type} sends the task's revision`);
    }
    assert.match(calendarModel, /val revision = sheet\?\.optString\("taskRevision"\)\.orEmpty\(\)/);
    assert.match(calendarModel, /internal fun JSONObject\.rowRevision\(\): String = optJSONObject\("row"\)\?\.optString\("taskRevision"\)\.orEmpty\(\)/);
    assert.match(boardModel, /if \(sameColumn\) action\.put\("afterId", afterId \?: JSONObject\.NULL\)/);
    // TalkBack reaches every card action (RN's swipes and a Move to per other column), with core's words, and hears the card
    // disabled with no actions while a command runs or a retry is owed (one semantics block: label, role and state).
    assert.match(boardUi, /if \(canEdit\) \{\s+onClick\(t\("common\.edit"\)\) \{ model\.openEditor\(id\); true \}\s+customActions = swipeActions\.map \{ \(side, label\) -> CustomAccessibilityAction\(label\)[^\n]*\+ moveActions\s+\} else disabled\(\)/);
    // Lines lie exactly at their minute (RN's offsets are RN bugs, fixed there separately): the day's 18-high hour rows and the
    // 10-high now line are centered on their minute, and the first hour label shows whole in the day and week timelines.
    assert.match(calendarUi, /Row\(Modifier\.offset\(y = \(index \* 60 \* PPM\)\.dp - 9\.dp\)\.fillMaxWidth\(\)\.height\(18\.dp\)/);
    assert.match(calendarUi, /Box\(Modifier\.fillMaxWidth\(\)\.padding\(vertical = 9\.dp\)\.height\(\(extent \* PPM\)\.dp\)/);
    assert.match(calendarUi, /Row\(Modifier\.offset\(y = \(minutes \* PPM\)\.dp - 5\.dp\)\.then\(modifier\)\.height\(10\.dp\)/);
    assert.match(calendarUi, /Box\(Modifier\.offset\(y = \(index \* 60 \* PPM\)\.dp\)\.fillMaxWidth\(\)\.height\(1\.dp\)/, 'a week hour rule lies at its minute');
    assert.match(calendarUi, /\.verticalScroll\(down\)\.padding\(top = 7\.dp, bottom = 24\.dp\)/, 'the week\'s first hour label shows whole');
    // The screens open from the More sheet, the Calendar also from the quick-access tab, each read on resume.
    assert.match(menuUi, /"calendar" -> CalendarList\(model\)\s+"board" -> BoardList\(model\)/);
    assert.match(menuUi, /"review" -> ReviewList\(model\)\s+"calendar" -> CalendarList\(model\)\s+\}/);
}

// Pass 9: the Inbox tab on core's Inbox view, selection mode on the Inbox, Waiting, Someday, Reference and Done on core's bulk
// contract, Archived's filter sheet, stateless Select all and completion time, and Focus's controls.
{
    // Reads pass Kotlin's input to core unchanged; writes are core's commands, logged as their operation.
    for (const [name, method] of [['inbox', 'getInboxView'], ['inboxTokens', 'getInboxFilterTokens'], ['archiveTokens', 'getArchiveFilterTokens'],
        ['bulk', 'getBulkActions'], ['focusList', 'getFocusControlsList']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuRead ${name} is core's ${method}`);
    }
    for (const [name, method] of [['bulkAction', 'runBulkAction'], ['focusGroup', 'setFocusGroupBy'], ['focusSave', 'saveFocusFilter'],
        ['focusCriterion', 'removeFocusFilterCriterion'], ['focusDelete', 'deleteFocusFilter'], ['focusReorder', 'reorderFocus']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuCommand ${name} is core's ${method}`);
    }
    // Every write is MenuModel's send -> perform(action) with its exact FailedAction: core's whole input (with the request UUID).
    assert.match(menuModel, /"bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> JSONObject\(action\.title\)\.put\("requestId", action\.id\)/);
    assert.match(menuModel, /"bulkAction" -> bulkDone\(action, reply\)\s+"focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> focusControls\.done\(action, reply\)/);
    assert.match(menuModel, /fun bulkAction\(action: JSONObject, busy: String\) \{\s+bulkBusy = busy\s+act\("bulkAction", bulkPayload\(action\) \?: return\)/);
    assert.match(menuModel, /confirm\(bulk\.getJSONObject\("deleteConfirmation"\), bulkPayload\(JSONObject\(\)\.put\("type", "trashTasks"\)\) \?: return, "bulkAction"\)/, 'a bulk delete asks core\'s question first');
    assert.match(menuModel, /undo\?\.let \{ whenIdle \{ bulkBusy = "undo"; act\("bulkAction", JSONObject\(\)\.put\("list", list\)\.put\("action", it\.getJSONObject\("action"\)\)\) \} \}/, 'Undo is core\'s restoreTasks, a new request UUID');
    assert.match(menuModel, /if \(reply\.optBoolean\("changed"\)\) endBulk\(list\)/, 'an action that changed something leaves selection mode');
    assert.match(focusModelKt, /private fun command\(kind: String, input: JSONObject\) = menu\.command\(kind, JSONObject\(input\.toString\(\)\)\.put\("controls", state\)\)/);
    assert.match(focusModelKt, /menu\.create\(FailedAction\("focusSave", open\.getString\("requestId"\), JSONObject\(\)\.put\("controls", state\)\.put\("name", name\)\.toString\(\)\)\)/,
        'a saved Focus filter is a create: its request UUID (the filter\'s id) and its input on disk before the call');
    assert.doesNotMatch(code(focusModelKt), /menuCommand\(|\bsend\(|shell\.perform\(action|FailedAction\((?!"focusSave")/, 'FocusModel writes only through MenuModel.command or create');
    for (const [name, text] of Object.entries({ inboxUi, bulkUi, focusControlsUi })) {
        assert.doesNotMatch(code(text).replace(/^import .*$/gm, ''), /runtime\.|menuCommand\(|menuRead\(|\bsend\(|shell\.perform|FailedAction\(|menu\.command|menu\.create/, `${name}: the screen reaches core only through its model`);
    }
    // The Inbox is RN's TaskList on core's getInboxView through the menu list machinery (paging, filters, folds); its sort is the
    // stored task-list sort (setTaskListSort); a heading's fold keeps core's collapseEdit whole under RN's key, for its grouping.
    assert.match(menuModel, /shell\.screen == Screen\.Inbox -> "inbox"/);
    // The Inbox reads only core's getInboxView: Kotlin has no getInboxWindow call left, and a full read carries no Inbox part.
    assert.doesNotMatch(code(kotlinFiles.join('\n') + inboxUi + bulkUi + focusControlsUi + focusModelKt), /inboxWindow|callAsync\("window"|InboxPage|Part\.Inbox/, 'no getInboxWindow read is left in Kotlin');
    assert.match(model, /private class Lists\(val focus: FocusView\?, val projects: ProjectsView\?, val projectId: String\?, val project: ProjectDetail\?, val areas: AreaFilter\)/);
    assert.match(menuModel, /if \(list != this\.list\) return\s+shell\.readSucceeded\(\)/, 'the Inbox view\'s (or a Menu list\'s) success clears a read\'s failure');
    assert.match(menuModel, /"reference", "inbox" -> send\(FailedAction\("taskListSort", value\)\)/);
    assert.match(menuModel, /"inbox" -> kept\(listOf\("groupBy", "filters"\)\)\.put\("collapsedGroupIds", GroupCollapse\.axis\(prefs, "inbox", own\.optString\("groupBy", "none"\), 200\)\)/);
    assert.match(menuModel, /if \(list == "inbox" && collapse != null\) GroupCollapse\.keep\(prefs, list, axis, collapse\.getJSONArray\("collapsedGroupIds"\)\)/);
    assert.match(menuUi, /Choice\(option\.getString\("label"\), option\.getBoolean\("selected"\)\) \{ sort\(option\.optJSONObject\("edit"\)\?\.getString\("sortBy"\) \?: option\.getString\("value"\)\) \}/);
    assert.match(activity, /if \(quick \|\| screen == Screen\.Inbox\) MenuDialogs\(model\)\s+if \(screen == Screen\.Focus\) FocusDialogs\(model\)/);
    assert.match(inboxUi, /empty\.getJSONObject\("action"\)\.optJSONObject\("filterEdit"\)\?\.let\(::filterEdit\) \?: model\.openCapture\(\)/, 'the empty state runs core\'s action');
    // A page belongs to the list it was read for, so a tab change never draws another list's reply.
    assert.match(menuModel, /val page: MenuPage\? get\(\) = loaded\?\.takeIf \{ it\.list == list \}/);
    // Selection mode: RN's session state (the Bundle), core's bar read with the list's accepted params, a row tap as core's
    // selectionEdit, Select all as core's stateless one; read-only rows never select.
    assert.match(menuModel, /bulk\?\.let \{ input -> page = page\.withBulk\(runtime\.menuRead\("bulk", JSONObject\(input\.toString\(\)\)\.put\("params", sent\)\.toString\(\)\)\) \}/);
    assert.match(menuModel, /bulk\.optJSONArray\("except"\)\?\.let \{ put\("selectAll", JSONObject\(\)\.put\("except", it\)\) \} \?: put\("taskIds", bulk\.optJSONArray\("selected"\) \?: JSONArray\(\)\)/);
    assert.match(menuModel, /bulk\.optJSONObject\("selectAll"\)\?\.let \{ put\("selectAll", it\) \}\s+\?: put\("taskIds", bulk\.getJSONArray\("selectedIds"\)\)\.put\("taskRevisions", bulk\.getJSONObject\("taskRevisions"\)\)/,
        'an action takes core\'s own Select all object, or the explicit selection with the revisions core\'s bar showed');
    assert.match(menuModel, /reload\(bulkEdit = JSONObject\(\)\.put\("selectionEdit", JSONObject\(\)\.put\("taskId", taskId\)\.put\("range", range\)\)\)/);
    assert.match(menuModel, /if \(list !in BULK_LISTS \|\| readOnly\) return null/);
    for (const [name, text] of Object.entries({ inboxUi, statusListUi, waitingUi, somedayUi })) assert.match(text, /actions = bulkRow\(/, `${name}: rows start and show selection mode`);
    assert.match(menuModel, /val BULK_LISTS = setOf\("inbox", "waiting", "someday", "reference", "done"\)/);
    // Archived: core's filter edits and chips (the deprecated fields are never read), its tokens paged by getArchiveFilterTokens with
    // the open sheet's filterSheetOpen, stateless Select all, and the completion time from a local day and time with core's start.
    assert.doesNotMatch(code(kotlinFiles.join('\n') + inboxUi + bulkUi + focusControlsUi + focusModelKt), /"tokenOptions"|"timeEstimateOptions"/, 'Kotlin never reads the deprecated Archive fields');
    assert.doesNotMatch(code(archiveUi + menuUi), /getJSONObject\("filters"\)\.menuObjects\("chips"\)/, 'chips come from the view\'s own `chips`, not the deprecated filters.chips');
    assert.match(menuModel, /if \(dialog\?\.optString\("kind"\) == "filters"\) put\("filterSheetOpen", true\)/);
    assert.match(menuModel, /own\.optJSONArray\("except"\)\?\.let \{ put\("selectAll", JSONObject\(\)\.put\("except", it\)\) \} \?: put\("selectedIds", own\.optJSONArray\("selected"\) \?: JSONArray\(\)\)/);
    assert.match(menuModel, /view\?\.optJSONObject\("selectAll"\)\?\.let \{ put\("selectAll", it\) \}\s+\?: put\("taskIds", view\?\.optJSONArray\("selectedIds"\) \?: JSONArray\(\)\)\.put\("taskRevisions", view\?\.optJSONObject\("taskRevisions"\) \?: JSONObject\(\)\)/);
    assert.match(menuModel, /archive\(JSONObject\(\)\.put\("type", "setCompletedAt"\)\.put\("taskId", open\.getString\("taskId"\)\)\.put\("day", open\.getString\("day"\)\)\.put\("time", time\)\s+\.put\("taskRevision", open\.optString\("taskRevision"\)\)\)/);
    // Archive's row and project actions carry the revision core's view showed (the row's taskRevision, the item's projectRevision).
    for (const type of ['moveToInbox', 'trashTask']) assert.match(archiveUi, new RegExp(`\\.put\\("type", "${type}"\\)\\.put\\("taskId", row\\.id\\)\\.put\\("taskRevision", row\\.taskRevision\\)`));
    for (const type of ['reactivateProject', 'trashProject']) assert.match(archiveUi, new RegExp(`\\.put\\("type", "${type}"\\)\\.put\\("projectId", id\\)\\.put\\("projectRevision", revision\\)`));
    assert.match(menuModel, /\.put\("taskRevision", row\.taskRevision\)\.put\("day", start\.getString\("day"\)\)/, 'the completion time picker keeps the row\'s revision');
    assert.match(archiveUi, /DayPickerDialog\(open\.getString\("day"\), [^\n]*\) \{ pickCompletedDay\(it\) \}/, 'the date dialog starts on core\'s day');
    assert.match(archiveUi, /val \(hour, minute\) = pickerClock\(open\.getString\("time"\)\)/, 'the time dialog starts on core\'s time');
    // Picker search (menu lists, the Inbox, Archive): core's matches for the typed query, read again when the list changes.
    assert.match(menuUi, /LaunchedEffect\(shown\.revision, name\) \{ if \(query\.isNotBlank\(\)\) searchPicker\(name, query,/);
    assert.match(menuUi, /for \(mode in filters\.menuObjects\("matchModes"\)\) MatchModeRow\(mode\.getString\("label"\), mode\.menuObjects\("options"\), idle\) \{ filterEdit\(it\) \}/);
    // Focus: every read sends the control state (asserted with the Focus bridge above); core's answer becomes the state; the state,
    // the open sheet and reorder mode ride the Bundle; reorder mode ends once core no longer offers it.
    for (const key of ['focusControls', 'focusDialog', 'focusReorder']) assert.match(focusModelKt, new RegExp(`saved(\\.get<\\w+>\\("${key}"\\)|\\["${key}"\\])`), `${key} rides the Bundle`);
    assert.match(focusModelKt, /keepState\(controls\.getJSONObject\("state"\)\)\s+if \(reordering && controls\.isNull\("reorder"\)\) keepReordering\(false\)/);
    assert.match(model, /private fun showFocus\(view: FocusView\?\) \{\s+focus = view\s+view\?\.let\(menu\.focusControls::adopt\)/);
    assert.match(focusControlsUi, /if \(to != index\) reorderTo\(ids\.toMutableList\(\)\.apply \{ add\(to, removeAt\(index\)\) \}, revisions\)/, 'a drop that moves nothing sends nothing; a move sends one reorderFocus');
    // reorderFocus sends each reorder row's taskRevision as core showed it.
    assert.match(focusControlsUi, /val revisions = JSONObject\(\)\.apply \{ rows\.forEach \{ put\(it\.getString\("id"\), it\.optString\("taskRevision"\)\) \} \}/);
    assert.match(focusModelKt, /command\("focusReorder", JSONObject\(\)\.put\("ids", JSONArray\(ids\)\)\.put\("taskRevisions", taskRevisions\)\)/);
    assert.match(focusControlsUi, /row\.optJSONArray\("moveUp"\)\?\.let \{ order -> CustomAccessibilityAction/, 'TalkBack moves a row by core\'s own order');
    // One node per new control: its label, role and state together (the device checks and TalkBack read it there). A backdrop
    // keeps a plain label: clearing its semantics would hide the sheet inside it.
    for (const [name, text] of Object.entries({ inboxUi, bulkUi, focusControlsUi })) {
        assert.doesNotMatch(code(text), /\.clickable\(enabled = [^\n]*\.semantics \{ contentDescription|\.semantics \{ contentDescription[^\n]*\}\s*\.clickable\(enabled/,
            `${name}: no control with a clickable and a separate semantics block`);
        assert(code(text).match(/clearAndSetSemantics \{/g).length >= 3, `${name}: its controls set label, role and state in one block`);
    }
    // No Kotlin policy in the new models and screens (the gates above also hold them to core's text and edits).
    for (const [name, text] of Object.entries({ focusModelKt, focusControlsUi, inboxUi, bulkUi })) {
        assert.doesNotMatch(code(text), /\.(sort\w*|sorted\w*|filter(?!Bg\b|Edit\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/, `${name}: no Kotlin sorting, filtering, or grouping`);
        assert.doesNotMatch(code(text), /SimpleDateFormat|DateTimeFormatter|LocalDate|java\.time|java\.util\.Calendar|Calendar\.getInstance|GregorianCalendar|Instant\b|\.format\(|toLocal/, `${name}: no Kotlin date formatting or parsing`);
    }
}

// Pass 12: Review's row Mark reviewed and Review in 1 week, its batch Mark reviewed and Organize sheet (compare-and-set on the task
// revisions core shows), the token and Board pickers' search, and RN's highlight of a task opened from search.
{
    const organizeKt = source('ReviewOrganize.kt');
    const boardModelKt = source('BoardModel.kt');
    const boardUiKt = source('BoardScreen.kt');
    // A row's links send core's own action (its task revision inside) with a new request UUID; Kotlin builds no row action. Each
    // link sets its label, role, state and test tag in its one semantics block.
    assert.match(reviewUi, /item\.json\.optJSONObject\("review"\)\?\.let \{ review ->[\s\S]{0,700}?act\("reviewAction", link\.getJSONObject\("action"\)\)/);
    assert.match(reviewUi, /\.clearAndSetSemantics \{ contentDescription = description; role = Role\.Button; testTag = tag; if \(enabled\) onClick \{ action\(\); true \} else disabled\(\) \}/);
    assert.doesNotMatch(code(reviewUi), /\.testTag\(tag\)/, 'the link\'s tag sits inside its semantics block');
    assert.doesNotMatch(code(Object.values(reviewScreens).join('\n') + organizeKt + menuModel), /put\("type", "markTaskReviewed"\)/, 'Kotlin never builds a row\'s Mark reviewed');
    // The batch Mark reviewed and Organize's Apply carry the revisions core's bar showed; neither is built without them.
    assert.match(listActionsKt, /internal fun markReviewedTasks\(taskIds: List<String>, taskRevisions: JSONObject\): JSONObject =\s+JSONObject\(\)\.put\("type", "markReviewedTasks"\)\.put\("taskIds", JSONArray\(taskIds\)\)\.put\("taskRevisions", taskRevisions\)/);
    assert.match(listActionsKt, /internal fun organizeTasks\(taskIds: List<String>, draft: JSONObject, taskRevisions: JSONObject\): JSONObject =\s+JSONObject\(\)\.put\("type", "organizeTasks"\)\.put\("taskIds", JSONArray\(taskIds\)\)\.put\("draft", draft\)\.put\("taskRevisions", taskRevisions\)/);
    assert.match(reviewUi, /"markReviewed" -> act\("reviewAction", markReviewedTasks\(selected, bulk\.getJSONObject\("taskRevisions"\)\)\)/);
    assert.match(menuModel, /else if \(review != null\) \{ bulkBusy = "organize"; act\("reviewAction", organizeTasks\(review\.getJSONArray\("selectedIds"\)\.ids\(\), organize\.getJSONObject\("draft"\), review\.getJSONObject\("taskRevisions"\)\)\) \}/);
    // A stale refusal wrote nothing and is never resent: core's view is read again, with its new revisions.
    assert.match(menuModel, /if \(refused && action\.kind == "reviewAction" && failure\.message\?\.startsWith\("STALE_REVISION"\) == true\) shell\.ui \{ bulkBusy = null; whenIdle \{ reload\(\) \} \}/);
    // Review's Organize is the lists' dialog on Review's own bar: the read carries the dialog (its draft, one control's edit, the
    // picker and its search), later windows go without it, and the page's bar is the view's.
    assert.match(menuModel, /first\.optJSONObject\("bulk"\)\?\.takeIf \{ list == "review" \}/);
    assert.match(menuModel, /JSONObject\(params\.toString\(\)\)\.apply \{\s+remove\("organize"\); remove\("picker"\)/, 'later windows go without the dialog\'s inputs');
    for (const list of ['contexts', 'review']) assert.match(menuModel, new RegExp(`"${list}" -> kept\\([\\s\\S]{0,240}?\\.also \\{ dialogInputs\\(list, it\\) \\}`), `${list}'s read carries its open dialog`);
    assert.match(menuModel, /if \(list == "review"\) bulkEdit\?\.optJSONObject\("organizeEdit"\)\?\.let \{ params\.optJSONObject\("organize"\)\?\.put\("edit", it\) \}/);
    assert.match(organizeKt, /into\.put\("organize", JSONObject\(\)\.put\("draft", open\.optJSONObject\("draft"\) \?: JSONObject\(\)\)\)/);
    assert.match(bulkUi, /val bulk = page\?\.bulk\?\.takeIf \{ list in BULK_LISTS \} \?: return/, 'the lists\' bar never draws Review\'s');
    assert.match(menuModel, /if \(type == "organizeTasks"\) \{ bulkBusy = null; closeDialog\("organize"\) \}/);
    // Core ends Review's selection when a selected row is no longer drawn (RN's review.tsx); the dialogs on it close with it.
    assert.match(menuModel, /if \(list == "review" && next\.bulk == null\) closeSelectionDialogs\(list\)/);
    // The token pickers' search: core's matching tokens (Contexts' picker, Review's and the lists' Remove tag query), the typed text
    // kept with the dialog and read once typing pauses; a blank search shows core's whole list.
    assert.match(organizeKt, /into\.put\("picker", \(if \(list == "review"\) JSONObject\(\)\.put\("kind", "removeTag"\) else JSONObject\(\)\.put\("field", open\.getString\("field"\)\)\.put\("mode", open\.getString\("mode"\)\)\)\s+\.put\("query", query\)\)/);
    assert.match(menuModel, /put\("picker", JSONObject\(\)\.put\("kind", "removeTag"\)\.apply \{ tokenQuery\(open\)\?\.let \{ put\("query", it\) \} \}\)/);
    assert.match(contextsUi, /BasicTextField\(text, \{ typed -> typeToken\(/);
    // The Board's picker search: getBoardList's query at the shown revision, read again whenever the Board changes.
    assert.match(boardModelKt, /runtime\.menuRead\("boardList", JSONObject\(\)\.put\("filters", shown\.filters\)\.put\("list", name\)\.put\("query", query\)\s+\.put\("offset", items\.length\(\)\)\.put\("limit", WINDOW\)\.put\("revision", shown\.revision\)\.toString\(\)\)/);
    assert.match(boardUiKt, /LaunchedEffect\(shown\.revision, picker\) \{ if \(query\.isNotBlank\(\)\) board\.searchPicker\(picker, query,/);
    // RN's highlight of a task opened from search, scoped to the list it opens on (the list under the search for the editor, the
    // hit's list for a route, the project once it opens): outlined only there, cleared after RN's 3.5 s or on leaving that list.
    assert.match(searchUi, /task\.editor -> \{ highlight\(task\.id\); openEditor\(task\.id\) \}\s+route != null -> \{ openFromSearch\(route, task\.projectId\); highlight\(task\.id, task\.projectId\) \}\s+listed != null -> \{ closeSearch\(\); menu\.openRoute\(listed\); highlight\(task\.id\) \}/);
    assert.match(model, /private fun listKey\(project: String\? = openProjectId\) = listOf\(menu\.screen\?\.name, menu\.list, screen\.name, project\)\.joinToString\("\|"\)/);
    assert.match(model, /fun isHighlighted\(taskId: String\) = taskId == highlightTaskId && highlightList == listKey\(\)/);
    assert.match(model, /withTimeoutOrNull\(3_500\) \{ snapshotFlow \{ listKey\(\) \}\.dropWhile \{ it != where \}\.first \{ it != where \} \}\s+highlightTaskId = null\s+highlightList = null/);
    assert.match(rowUi, /listed == null && isHighlighted\(task\.id\)/);
    assert.doesNotMatch(code(rowUi), /== highlightTaskId/, 'a row asks the model, which knows the list the highlight belongs to');
    // The new file holds dialog inputs only: no Kotlin policy, no UI text, no write around perform.
    assert.doesNotMatch(code(organizeKt), /\.(sort\w*|sorted\w*|filter\w*|groupBy|distinct\w*)\b|SimpleDateFormat|LocalDate|java\.time|\bText\(|contentDescription|\bsend\(|shell\.perform|FailedAction\(|runtime\./,
        'ReviewOrganize.kt: dialog inputs only');
    // The device check: English for the run (the original language put back), an owed failure settled first, then this run's
    // fixtures removed (never while a write is owed), and an Apply that assigns a project; --prune-old removes interrupted runs' data.
    const check12 = readFileSync(resolve(app, 'scripts/check-review-organize-device.mjs'), 'utf8');
    const restore12 = check12.slice(check12.indexOf('const restore = async () => {'));
    assert(restore12.indexOf('await settleOwed();') > 0 && restore12.indexOf('await settleOwed();') < restore12.indexOf('await removeFixtures();'), 'cleanup settles an owed failure before removing the fixtures');
    assert.match(check12, /const removeFixtures = async \(\) => \{\s+if \(!injected\) return;\s+if \(owed\) \{/);
    assert.match(check12, /done\(await store\(\)\.batchDeleteTasks\(tasks\)\); done\(await store\(\)\.purgeTasks\(tasks\)\);/);
    assert.match(check12, /setProp\('language', 'en'\);/);
    assert.match(check12, /const originalLanguage = sh\('getprop debug\.mindwtr\.native\.language'\);[\s\S]*setProp\('language', originalLanguage\)/);
    assert.doesNotMatch(check12, /setProp\('language', ''\)|for \(const name of PROPS\)/, 'the run never clears the language property to the app\'s own');
    assert.match(check12, /task\.projectId === injected\.project && task\.areaId === null && task\.dueDate === today\.value/);
    assert.match(readFileSync(resolve(app, 'scripts/check-projects-device.mjs'), 'utf8'), /\/\^76\[0-9\]\{12\}\[1-6\]\$\/[\s\S]{0,900}?\/\^76\[0-9\]\{12\}9\$\/[\s\S]{0,500}?\/\^76\[0-9\]\{12\}\[07\]\$\//,
        '--prune-old removes the Review organize check\'s tasks, project and areas');
    // Core draws Review's bar in RN's order (Mark reviewed first on Due), so Kotlin keeps core's order.
    const reviewContract = readFileSync(resolve(app, '../../packages/core/src/native-host-contract-review-views.ts'), 'utf8');
    assert.match(reviewContract, /actions: \[\s+\.\.\.\(scope === 'due' \? \[\{ id: 'markReviewed' as const, label: text\.markReviewed, enabled: true \}\] : \[\]\),\s+\{ id: 'organize'/);
}

// Pass 10: Settings (the menu, General, Manage with its Someday sections, and GTD's seven screens) on core's settings contract,
// and the editor's View tab and checklist editing on core's task view contract.
{
    const settingsModel = source('SettingsModel.kt');
    const settingsUi = source('SettingsScreen.kt');
    const taskViewUi = source('TaskView.kt');
    const settingsIcons = source('SettingsIcons.kt');
    const pass10 = { settingsModel, settingsUi, taskViewUi, settingsIcons };
    const coreFile = (name) => readFileSync(resolve(app, '../../packages/core/src', name), 'utf8');
    // Reads pass Kotlin's input to core unchanged; writes are core's commands, each logged as its operation.
    for (const [name, method] of [['settingsMenu', 'getSettingsMenu'], ['generalSettings', 'getGeneralSettings'], ['gtdSettings', 'getGtdSettings'],
        ['manageSettings', 'getManageSettings'], ['manageList', 'getManageSettingsList'], ['somedaySections', 'getSomedaySections']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuRead ${name} is core's ${method}`);
    }
    for (const [name, method] of [['generalSetting', 'setGeneralSetting'], ['gtdSetting', 'setGtdSetting'], ['manageEditor', 'saveManageEditor'],
        ['manageDelete', 'deleteManageItem'], ['somedayRename', 'renameSomedaySection'], ['somedayReorder', 'reorderSomedaySections'], ['somedayDelete', 'deleteSomedaySection']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuCommand ${name} is core's ${method}`);
    }
    // Every Settings write is MenuModel's send -> perform(action) with its exact FailedAction: a control's edit through command (a new
    // request UUID; core's whole input its exact retry), Manage's editor Save through create (its request UUID kept with the dialog, on
    // disk before the call), a delete through core's question (MenuDialogs' confirm -> act).
    assert.match(settingsModel, /fun general\(edit: JSONObject\) = menu\.command\("generalSetting", JSONObject\(\)\.put\("edit", edit\)\)/);
    assert.match(settingsModel, /fun gtd\(edit: JSONObject\) = menu\.command\("gtdSetting", JSONObject\(\)\.put\("edit", edit\)\)/);
    assert.match(settingsModel, /fun saveEditor\(action: FailedAction\) = menu\.create\(action\)/);
    assert.match(settingsModel, /return FailedAction\("manageEditor", open\.getString\("requestId"\), input\.toString\(\)\)/, 'the editor\'s request UUID stays with its dialog');
    assert.match(menuModel, /"generalSetting", "gtdSetting", "manageEditor", "manageDelete", "dataSetting", "syncPreference", "setAISetting" -> JSONObject\(action\.title\)\.put\("requestId", action\.id\)/);
    assert.match(menuModel, /"somedayRename", "somedayReorder", "somedayDelete" -> JSONObject\(action\.title\)/);
    for (const call of ['"manageDelete")', '"somedayDelete")']) {
        const at = settingsUi.indexOf(call);
        assert(at > 0 && settingsUi.slice(Math.max(0, at - 200), at).includes('confirm('), `Settings deletes only after core's question (${call})`);
    }
    assert.doesNotMatch(code(settingsUi).replace(/^import .*$/gm, ''), /runtime\.|menuCommand\(|menuRead\(|\bsend\(|shell\.perform|FailedAction\(|menu\.command|menu\.create/, 'SettingsScreen reaches core only through SettingsModel');
    assert.doesNotMatch(code(settingsModel), /menuCommand\(|\bsend\(|shell\.perform\(action|\.perform\([A-Za-z]/, 'SettingsModel writes only through MenuModel.command or create');
    // Core's device writes are stored under RN's keys before the command counts as done; a new language reloads core's words, a theme its colors.
    assert.match(menuModel, /if \(action\.kind in SETTINGS_KINDS\) settings\.applied\(runtime, reply\)\s+shell\.acknowledged\(action\)/);
    assert.match(settingsModel, /internal fun applied\(runtime: CoreHost, reply: JSONObject\) \{\s+val writes = reply\.optJSONArray\("deviceWrites"\) \?: return\s+val keys = /);
    // A setting's deviceWrites are stored in CoreHost's one call path (the first send and the journal's replay), durably, before the
    // write's journal entry settles; the Settings screen only reloads the language and theme after.
    assert.doesNotMatch(settingsModel.slice(settingsModel.indexOf('internal fun applied(')), /^\s+store\(writes\)/m);
    // Each device key keeps the journal sequence of the write that set it (DeviceWrites, one commit with the value): a replay
    // applies a key only when its entry is newer, so an old entry whose delete failed never undoes a newer setting; the journal
    // numbers new entries above every recorded sequence, so the numbering never goes back after the journal empties.
    assert.match(settingsModel, /fun deviceStore\(prefs: SharedPreferences\) = DeviceWrites\(\{ prefs\.all \}, \{ changes ->\s+prefs\.edit\(\)\.apply \{[^\n]*\}\.commit\(\)\s+\}\)/);
    assert.match(settingsModel, /fun deviceStore\(app: Context\) = deviceStore\(app\.getSharedPreferences\(DEVICE_PREFS, Context\.MODE_PRIVATE\)\)/);
    assert.match(settingsModel, /private fun store\(writes: JSONArray\) = deviceStore\(prefs\)\.store\(writes, null, replay = false\)/);
    {
        const devicesKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/DeviceWrites.kt'), 'utf8');
        assert.match(devicesKt, /if \(replay && sequence != null && sequenceOf\(now\[key \+ SEQUENCE\]\) >= sequence\) continue\s+changes\[key\] = [^\n]+\s+if \(sequence != null\) changes\[key \+ SEQUENCE\] = sequence\.toString\(\)/);
        assert.match(devicesKt, /if \(changes\.isNotEmpty\(\)\) check\(commit\(changes\)\) \{ "Cannot store the device settings" \}/);
        assert.match(coreHost, /journal = WriteJournal\(journalDir, log = \{ Log\.i\(TAG, it\) \}, floor = devices\.highestSequence\(\)\)/);
        assert.match(readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournal.kt'), 'utf8'), /\n        next = maxOf\(next, floor \+ 1\)\n/);
        const devicesTest = readFileSync(resolve(app, 'android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/DeviceWritesTest.kt'), 'utf8');
        for (const name of ['aReplayNeverUndoesANewerSetting', 'theJournalStartsAboveEverySequenceASettingHolds', 'aFirstSendAlwaysAppliesAndAFailedCommitThrows']) {
            assert.match(devicesTest, new RegExp(`@Test fun ${name}\\(\\)`));
        }
    }
    assert.match(model, /app\.getSharedPreferences\(DEVICE_PREFS, /);
    assert.match(coreHost, /private fun settle\(entry: WriteJournal\.Entry\?, result: JSONObject, replay: Boolean\): Boolean \{\s+result\.optJSONObject\("value"\)\?\.optJSONArray\("deviceWrites"\)\?\.let \{ devices\.store\(it, entry\?\.sequence, replay\) \}\s+return entry != null && checkNotNull\(journal\)\.settle\(entry, result\.error\(\), replay\)/);
    assert.equal(coreHost.match(/(?<!\.)\bsettle\(entry, /g).length, 2, 'settle(): the first send and the replay');
    assert.match(settingsModel, /runtime\.language\(prefs\.getString\(LANGUAGE_KEY, null\)\.orEmpty\(\), Locale\.getDefault\(\)\.toLanguageTag\(\)\)\s+Labels\.load\(runtime\.strings\(LABEL_KEYS\)\)/);
    assert.match(model, /val runtime = ProcessCoreHost\.get\(getApplication\(\), prefs\.getString\(LANGUAGE_KEY, null\)\)\s+\/\/[^\n]*\s+applyDeviceChoices\(runtime, prefs\)/, 'the device\'s own language and theme apply at boot, before any screen');
    for (const [kotlin, file, core] of [['LANGUAGE_KEY', 'i18n/i18n-constants.ts', 'LANGUAGE_STORAGE_KEY'], ['THEME_KEY', 'general-settings-model.ts', 'MOBILE_THEME_STORAGE_KEY'],
        ['MANAGE_SECTIONS_KEY', 'manage-settings-model.ts', 'MANAGE_OPEN_SECTIONS_STORAGE_KEY'], ['TASK_OPEN_MODE_KEY', 'gtd-settings-model.ts', 'MOBILE_TASK_OPEN_MODE_STORAGE_KEY']]) {
        const value = new RegExp(`export const ${core} = '([^']+)'`).exec(coreFile(file))[1];
        assert.match(settingsModel, new RegExp(`const val ${kotlin} = "${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `${kotlin} is core's ${core}`);
    }
    // Kotlin builds only the two text fields' edits (core's GtdSettingsEdit names), from the typed text; every choice sends core's own edit.
    const gtdEdits = [...coreFile('gtd-settings-model.ts').matchAll(/type: '(\w+)'/g)].map(([, name]) => name);
    const built = [...code(settingsModel + settingsUi).matchAll(/put\("type", "(\w+)"\)/g)].map(([, name]) => name);
    assert.deepEqual([...new Set(built)].sort(), ['defaultScheduleTime', 'pomodoroDurations'], 'only the typed text fields build an edit');
    for (const name of built) assert(gtdEdits.includes(name), `${name} is one of core's GTD edits`);
    assert(code(settingsUi).match(/getJSONObject\("edit"\)/g).length >= 10, 'the controls send core\'s edits');
    // Settings' rows come from core as they are: a screen core says is not built here is drawn disabled; the Manage editor's taken-name
    // line and Save state are core's checkManageEditor for the name as typed (read off the main thread); Kotlin holds no copy of the rule.
    assert.match(settingsUi, /val enabled = row\.getBoolean\("enabled"\) && idle/);
    assert.match(hostEntry, /^\s+manageCheck: \(input\) => contract\.checkManageEditor\(input\),$/m, 'menuRead manageCheck is core\'s checkManageEditor');
    assert.match(settingsModel, /shell\.background\(listOf\(Part\.MenuDialog\), \{ runtime ->\s+runtime\.menuRead\("manageCheck", JSONObject\(\)\.put\("target", target\)\.put\("name", name\)\.toString\(\)\)/);
    assert.match(settingsUi, /val canSave = owed \|\| \(idle && checked != null && !checked\.getBoolean\("saveDisabled"\)\)/);
    assert.match(settingsUi, /checked\?\.menuText\("message"\)\?\.let \{ Text\(it,/);
    assert.doesNotMatch(code(settingsUi + settingsModel), /lowercase\(\)|nameTaken"\)|isManageAreaNameTaken/, 'no Kotlin copy of core\'s taken-name rule');
    // Manage's icon buttons name their item as RN's (a6e345eab): "<common.edit>: <name>" and "<common.delete>: <name>"; sections report expanded.
    assert.match(settingsUi, /RowButton\(SettingsIonicons\.PencilOutline, "\$\{t\("common\.edit"\)\}: \$\{unassigned\.getString\("label"\)\}"/);
    assert.equal(code(settingsUi).match(/"\$\{t\("common\.(edit|delete)"\)\}: \$(name|value)"/g).length, 4, 'area and value rows name their item');
    assert.match(settingsUi, /if \(open\) collapse \{ settings\.toggleSection\(section\.getJSONObject\("toggle"\)\); true \} else expand \{/);
    // Navigation: the Settings tile opens, RN's settings stack pops on Back, and the stack, search and screen state ride the Bundle.
    assert.match(menuModel, /"settings" -> open\(MenuScreen\.Settings\)/);
    assert.match(menuModel, /if \(screen == MenuScreen\.Settings && settings\.back\(\)\) return/);
    assert.match(menuModel, /if \(list == "settings"\) return settings\.refresh\(\)/);
    for (const key of ['settingsStack', 'settingsQuery', 'settingsLocal']) assert.match(settingsModel, new RegExp(`saved(\\.get<\\w+>\\("${key}"\\)|\\["${key}"\\])`), `${key} rides the Bundle`);
    assert.match(menuUi, /"settings" -> SettingsList\(model\)/);
    // Manage's lists page under Manage's revision; a list that changed between windows keeps what it read (the next read starts over).
    assert.match(settingsModel, /runtime\.menuRead\("manageList", JSONObject\(\)\.put\("list", list\)\.put\("offset", loaded\.size\)\.put\("limit", WINDOW\)\s*\.put\("revision", view\.getString\("revision"\)\)/);
    assert.match(settingsModel, /\.put\("revision", first\.getString\("revision"\)\)/);
    assert.match(settingsModel, /if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure/);

    // The editor's View tab: core's getTaskView for the draft and checklist the editor holds, read in the background with its own
    // freshness, its checklist paged under the first window's revision; a read-only task shows the saved task.
    assert.match(model, /if \(!current\.readOnly\) input\.put\("draft", JSONObject\(draftJson\(current\.fullDraft\(\)\)\)\)\.put\("checklist", JSONArray\(current\.checklistNow\)\)/);
    assert.match(model, /background\(listOf\(Part\.TaskView\), \{ runtime -> readView\(runtime, input, depth\) \}\) \{ view, mine ->\s+if \(fresh\(mine, Part\.TaskView\) && editor\?\.id == current\.id\) taskView = view/);
    assert.match(model, /\.put\("offset", items\.length\(\)\)\.put\("limit", VIEW_WINDOW\)\s*\.put\("revision", first\.getString\("revision"\)\)/);
    // RN's resolveTaskOpenTab: read-only shows only the View tab; an explicit edit the Form tab; then the device's "Open tasks in";
    // then the list's own tab: the Inbox list's is the Form tab (defaultEditTab="task"), every other screen's, a search's and a link's View.
    assert.match(model, /val automatic = routeTab \?: if \(menu\.screen == null && screen == Screen\.Inbox && search == null\) "task" else "view"/);
    assert.match(model, /val tab = if \(opened\.readOnly\) "view" else if \(routeTab == "task"\) "task" else if \(mode == "preview"\) "view" else if \(mode == "edit"\) "task" else automatic/);
    // RN's explicit edits (openTaskScreen(…, 'task'), the review's Add task and edit): Save & edit, the Board's Duplicate, the Weekly Review's Add task.
    assert.match(model, /menu\.whenIdle \{ openEditor\(taskId, "task"\) \}/);
    assert.match(source('BoardModel.kt'), /shell\.openEditor\(open\.getString\("taskId"\), "task"\)/);
    assert.match(menuModel, /shell\.openEditor\(id, "task"\)/);
    assert.match(editorUi, /if \(editor\.readOnly \|\| editor\.tab == "view"\) TaskViewTab\(/);
    assert.match(editorUi, /\.put\("checklist", checklist \?: JSONObject\.NULL\)\.put\("tab", tab\)/, 'the open tab and the checklist ride the draft file');
    // Every checklist change is one of core's TaskChecklistEdit kinds, queued with the draft's edits; Kotlin never edits an item itself.
    const checklistKinds = [...(/export type TaskChecklistEdit =([\s\S]*?);\n\n/.exec(coreFile('task-checklist-model.ts'))?.[1] ?? '').matchAll(/kind: '(\w+)'/g)].map(([, kind]) => kind);
    assert(checklistKinds.includes('toggle') && checklistKinds.includes('append'), 'core\'s checklist edit kinds were read');
    const kinds = [...code(taskViewUi + model).matchAll(/editChecklist\(JSONObject\(\)\.put\("kind", "(\w+)"\)/g)].map(([, kind]) => kind);
    assert(kinds.length >= 7);
    for (const kind of kinds) assert(checklistKinds.includes(kind), `${kind} is one of core's checklist edits`);
    assert.doesNotMatch(code(taskViewUi), /editChecklist\(JSONObject\(\)\.put\("kind", [^"]/, 'no checklist edit kind is built from a variable');
    // A queued item edit names its item by its stable id (a move by its direction); its position is read only right before the edit is
    // sent, from the checklist as the edits before it left it, and an edit whose item is gone is dropped. The screen never sends a position.
    assert.doesNotMatch(code(taskViewUi), /put\("(index|from|to)"/, 'the checklist screens send no position');
    assert.equal(code(taskViewUi).match(/put\("itemId", /g).length, 9, 'every item edit (the View and Form ticks and moves, each semantics and click; rename, Return, remove) names its item');
    assert.match(model, /private fun currentChecklistEdit\(edit: JSONObject, checklist: String\): JSONObject\? \{\s+if \(!edit\.has\("itemId"\)\) return edit\s+val items = JSONArray\(checklist\)\s+val index = \(0 until items\.length\(\)\)\.firstOrNull \{ items\.getJSONObject\(it\)\.getString\("id"\) == edit\.getString\("itemId"\) \} \?: return null/);
    assert.match(model, /val to = index \+ edit\.getInt\("step"\)\s+return if \(to in 0 until items\.length\(\)\) sent\.put\("from", index\)\.put\("to", to\) else null/);
    assert.match(model, /val listEdit = queued\?\.let \{ currentChecklistEdit\(it, current\.checklistNow\) \}/);
    assert.equal(code(model).match(/currentChecklistEdit\(/g).length, 2, 'resolved in one place, in stepEditor, right before the send');
    // Reset checklist writes at once through perform with its exact retry (its request UUID and the View tab's taskRevision), then the
    // reset task is the editor's base. A task changed since (STALE_REVISION) wrote nothing: the View tab is read again, with its new revision.
    assert.match(model, /val revision = taskView\?\.takeIf \{ it\.getString\("id"\) == current\.id \}\?\.optString\("taskRevision"\) \?: return\s+sendReset\(FailedAction\("resetChecklist", current\.id, UUID\.randomUUID\(\)\.toString\(\), patch = mapOf\("taskRevision" to revision\)\)\)/);
    assert.match(model, /private fun sendReset\(action: FailedAction\) = perform\(action\) \{ runtime ->\s+try \{\s+runtime\.resetTaskChecklist\(action\.id, action\.title, action\.patch\["taskRevision"\]\.orEmpty\(\)\)\s+\} catch \(failure: Exception\) \{\s+[^\n]*\n\s+if \(failure\.message\?\.startsWith\("STALE_REVISION"\) == true\) ui \{ menu\.whenIdle \{ readTaskView\(\) \} \}\s+throw failure\s+\}\s+acknowledged\(action\)/);
    assert.match(model, /"resetChecklist" -> sendReset\(action\)/);
    // A link is core's target: a web, mail or phone link opens outside the app; a project, task, context or tag leaves the editor as
    // Close does (asking first while edits are unsaved).
    const followLink = /val follow = \{ target: JSONObject ->([\s\S]*?)\n        Unit\n    \}/.exec(editorUi)?.[1];
    assert(followLink, 'the editor has an explicit link-follow handler');
    assert.match(followLink, /^\s*if \(target\.getString\("kind"\) == "external"\) \{\s+val original = target\.getString\("href"\)\s+val upnote = openUpNoteLink\(context, original, ::t\) \{ outcome ->\s+anyTime\(\{ it\.logLinkHandoff\(outcome, "markdown"\) \}, \{\}\)\s+\}\s+if \(upnote == null\) runCatching \{ context\.startActivity\(Intent\(Intent\.ACTION_VIEW, original\.toUri\(\)\)\) \}\s+\}\s+else if \(editor\.readOnly \|\| \(!editor\.dirty && !editsPending\)\) go\(target\)\s+else \{ linkAfterLeave = target\.toString\(\); confirmLeave = true \}\s*$/, 'UpNote has explicit recovery; other external links retain their opener and internal navigation retains the unsaved-edit guard');
    assert.match(taskViewUi, /withLink\(LinkAnnotation\.Clickable\(target\.toString\(\), TextLinkStyles\(SpanStyle\(color = tint, textDecoration = TextDecoration\.Underline\)\)\) \{ follow\(target\) \}\)/);
    // No Kotlin policy in the new files: core's rows, options and words walked as sent; no dates.
    for (const [name, text] of Object.entries(pass10)) {
        assert.doesNotMatch(code(text), /\.(sort\w*|sorted\w*|filter(?!Bg\b|Edit\b|s\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/, `${name}: no Kotlin sorting, filtering, or grouping`);
        assert.doesNotMatch(code(text), /SimpleDateFormat|DateTimeFormatter|LocalDate|LocalTime|java\.time|java\.util\.Calendar|Calendar\.getInstance|GregorianCalendar|Instant\b|\.format\(|toLocal|currentTimeMillis|\bDate\(|TimeZone/, `${name}: no Kotlin date math, formatting or parsing`);
        assert.doesNotMatch(code(text), new RegExp(`${STATUS}(?:\\s*,\\s*${STATUS})*\\s*->\\s*${STATUS}`), `${name}: no status-to-status map`);
        assert.doesNotMatch(code(text), /\bColor\(|Color\.(Black|White|Red|Green|Blue|Gray|Yellow|Cyan|Magenta|DarkGray|LightGray|Transparent)\b|parseColor|"#[0-9A-Fa-f]{3,8}"|0x[0-9A-Fa-f]{8}/, `${name} writes a color; colors live only in Theme.kt`);
        // No literal text reaches a Text, a content description, or a click label; key literals are label keys.
        for (const [, key] of code(text).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)"/g)) assert(labelKeys.includes(key), `${name}: ${key} is not in LABEL_KEYS`);
        for (const [, rest] of code(text).matchAll(/(?:\bText\(|contentDescription = |onClickLabel = )([^\n]*)/g)) {
            // Core's JSON is read by key (getString("label"), getJSONObject("edit")); a key names a field of core's text, it is not text.
            for (const [, literal] of rest.replace(/\b(t|testTag|getString|optString|text|getJSONObject|optJSONObject|getBoolean|optBoolean|getInt|menuText|menuObjects)\("[^"]*"\)/g, '').replace(/\btestTag = "[^"]*"/g, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
                if (labelKeys.includes(literal)) continue;
                assert.doesNotMatch(literal.replace(/\$\{[^}]*\}|\$\w+/g, ''), /\p{L}/u, `${name}: hard-coded UI text "${literal}"`);
            }
        }
    }
    // One semantics block per control (label, role and state), as passes 6-8 ruled.
    assert(code(settingsUi).match(/\.clearAndSetSemantics \{/g).length >= 15);
    assert(code(taskViewUi).match(/\.clearAndSetSemantics \{/g).length >= 6);
}

// App lock: RN's MobileAppLockGate and General's switch on core's General row for it (`settings.security.mobileAppLockEnabled`,
// per device), with RN's device lock prompt and lock screen.
{
    const lockKt = source('AppLock.kt');
    const settingsUi = source('SettingsScreen.kt');
    const settingsModel = source('SettingsModel.kt');
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    // The gate reads core's row through its own host call, which no failed save blocks: a lock turned on whose save is owed still locks.
    assert.match(hostEntry, /appLock\(\): string \{\s*return submit\(async \(\) => unwrap\(contract\.getGeneralSettings\(\{\}\)\)\.privacy\.appLock\);/);
    assert.doesNotMatch(hostEntry.slice(hostEntry.indexOf('appLock(): string {'), hostEntry.indexOf('    projects(): string {')), /requireSaved/);
    assert.match(coreHost, /fun appLock\(\): JSONObject = callAsync\("appLock"\)/);
    // At boot, before any screen reads data (the owed-retry restore included), the app opens locked while core says on.
    assert.match(model, /applyDeviceChoices\(runtime, prefs\)\s+\/\/[^\n]*\n\s+lock\.boot\(runtime\)\s+ProcessCoreHost\.failure\?\.let/);
    assert.match(lockKt, /val on = runtime\.appLock\(\)\.getBoolean\("value"\)\s+shell\.ui \{ enabled = on; locked = on \}/);
    // The gate wraps every screen inside the one theme; while locked the lock screen replaces them (RN's gate renders it instead of
    // its children), and the screens' saved state waits for the unlock.
    assert.match(activity, /MindwtrTheme\(if \(model\.loading\) null else ThemeChoice\.current\) \{ AppLockGate\(model\) \{ with\(model\) \{/);
    assert.match(lockKt, /if \(model\.lock\.locked && !model\.loading\) AppLockScreen\(model\) else screens\.SaveableStateProvider\("app", content\)/);
    // RN locks when AppState leaves active (Android's onPause), not for a rotation, not while its own prompt is up; each lock
    // prompts by itself once, 250 ms after the app is active.
    assert.match(lockKt, /if \(event == Lifecycle\.Event\.ON_PAUSE\) model\.lock\.paused\(activity\?\.isChangingConfigurations == true\)/);
    assert.match(lockKt, /if \(!enabled \|\| authenticating \|\| rotating\) return\s+locked = true\s+failure = null\s+locks \+= 1/);
    assert.match(lockKt, /fun shouldPrompt\(resumed: Boolean\) = enabled && locked && !authenticating && resumed && prompted != locks/);
    assert.match(lockKt, /private const val PROMPT_DELAY_MS = 250L/);
    // The device lock as expo-local-authentication asks it (correction pass, finding 4): AndroidX BiometricPrompt at Expo's version on
    // a FragmentActivity, weak biometrics or the device credential, confirmation required, no cancel button (Android refuses one
    // beside the credential); no secure screen lock, or no Activity, is "unavailable".
    const gradle = readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8');
    assert.match(gradle, /implementation\("androidx\.biometric:biometric:1\.2\.0-alpha04"\)/, 'expo-local-authentication\'s androidx.biometric');
    assert.match(gradle, /implementation\("androidx\.fragment:fragment:1\.8\.\d+"\)/, 'a fragment that knows activity 1.10\'s result registry');
    assert.match(activity, /class MainActivity : FragmentActivity\(\) \{/);
    assert.match(lockKt, /^import androidx\.biometric\.BiometricPrompt$/m);
    assert.doesNotMatch(lockKt, /android\.hardware\.biometrics/, 'no platform prompt beside AndroidX\'s');
    assert.match(lockKt, /prompt\(title, Authenticators\.BIOMETRIC_WEAK or Authenticators\.DEVICE_CREDENTIAL\)/);
    assert.match(lockKt, /val activity = host\?\.get\(\) \?: return answered\("unavailable"\)\s+try \{\s+if \(!activity\.getSystemService\(KeyguardManager::class\.java\)\.isDeviceSecure\) return answered\("unavailable"\)\s+if \(activity\.supportFragmentManager\.isStateSaved\) return answered\("cancelled"\)/);
    assert.match(lockKt, /BiometricPrompt\.PromptInfo\.Builder\(\)\.setTitle\(title\)\.setAllowedAuthenticators\(authenticators\)\.setConfirmationRequired\(true\)\.build\(\)/);
    assert.match(lockKt, /BiometricPrompt\(activity, ContextCompat\.getMainExecutor\(activity\), object : BiometricPrompt\.AuthenticationCallback\(\) \{\s+override fun onAuthenticationSucceeded\(result: BiometricPrompt\.AuthenticationResult\) = answered\(null\)\s+override fun onAuthenticationError\(code: Int, message: CharSequence\) = failed\(title, code\)/);
    // The Activity on screen is the gate's, weakly held and let go with its composition.
    assert.match(lockKt, /main\?\.let\(model\.lock::attach\)[\s\S]{0,400}?onDispose \{\s+owner\.lifecycle\.removeObserver\(observer\)\s+main\?\.let\(model\.lock::detach\)/);
    assert.match(lockKt, /private var host: WeakReference<MainActivity>\? = null/);
    // Expo's bounded fallback (finding 3): a biometric that cannot be used, on a secure device, asks once for the credential alone:
    // Android's credential screen before Android 11 (MainActivity.credential answers), a credential-only prompt from 11.
    assert.match(lockKt, /private val BIOMETRIC_UNUSABLE = setOf\(BiometricPrompt\.ERROR_HW_NOT_PRESENT, BiometricPrompt\.ERROR_HW_UNAVAILABLE, BiometricPrompt\.ERROR_NO_BIOMETRICS,\s+BiometricPrompt\.ERROR_UNABLE_TO_PROCESS, BiometricPrompt\.ERROR_NO_SPACE\)/);
    assert.match(lockKt, /if \(code !in BIOMETRIC_UNUSABLE \|\| fallback\) return answered\(reason\(code\)\)[\s\S]{0,300}?if \(!keyguard\.isDeviceSecure\) return answered\(reason\(code\)\)\s+fallback = true\s+if \(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.R\) activity\.credential\.launch\(keyguard\.createConfirmDeviceCredentialIntent\(title, null\)\)\s+else prompt\(title, Authenticators\.DEVICE_CREDENTIAL\)/);
    assert.match(lockKt, /internal fun answered\(reason: String\?\) \{\s+authenticating = false\s+fallback = false/);
    assert.match(activity, /internal val credential = registerForActivityResult\(ActivityResultContracts\.StartActivityForResult\(\)\) \{\s+model\.lock\.answered\(if \(it\.resultCode == RESULT_OK\) null else "cancelled"\)/);
    assert.match(lockKt, /BiometricPrompt\.ERROR_CANCELED, BiometricPrompt\.ERROR_NEGATIVE_BUTTON, BiometricPrompt\.ERROR_USER_CANCELED -> "cancelled"/);
    assert.doesNotMatch(code(lockKt), /setNegativeButton|mobileAppLockEnabled|menuCommand\(/, 'no cancel button, and Kotlin never writes the setting itself');
    assert.match(manifest, /<uses-permission android:name="android\.permission\.USE_BIOMETRIC" \/>/);
    // Recents keep no picture while App lock is on (finding 2, stronger than RN by ruling): recents screenshots off from Android 13,
    // FLAG_SECURE before, following core's value on every Activity.
    assert.match(lockKt, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU\) activity\.setRecentsScreenshotEnabled\(!on\)\s+else if \(on\) activity\.window\.addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)\s+else activity\.window\.clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
    assert.match(lockKt, /val on = model\.lock\.enabled\s+LaunchedEffect\(activity, on\) \{ activity\?\.let \{ protectRecents\(it, on\) \} \}/);
    // A lock turned on whose save failed (finding 1): core applied it in memory, so the gate follows core's value at once while the
    // exact retry stays owed (the failure is rethrown to perform, which keeps it).
    assert.match(menuModel, /if \(!refused && action\.kind == "generalSetting"\) settings\.unsettled\(runtime, action\)\s+throw failure/);
    assert.match(settingsModel, /internal fun unsettled\(runtime: CoreHost, action: FailedAction\) \{\s+if \(JSONObject\(action\.title\)\.getJSONObject\("edit"\)\.getString\("type"\) != "appLock"\) return\s+runCatching \{ runtime\.appLock\(\)\.getBoolean\("value"\) \}\.onSuccess \{ on -> shell\.ui \{ shell\.lock\.stored\(on\) \} \}/);
    // The lock screen stays centered and scrolls when large text does not fit a short landscape window (finding 5).
    assert.match(lockKt, /BoxWithConstraints\(Modifier\.fillMaxSize\(\)[^\n]*\.testTag\("app-lock"\)\) \{\s+Column\(Modifier\.fillMaxWidth\(\)\.verticalScroll\(rememberScrollState\(\)\)\.heightIn\(min = maxHeight\)/);
    // A failed prompt's line is RN's (getMobileAppLockErrorKey) in core's words.
    for (const reason of ['unavailable', 'cancelled', 'failed']) assert.match(lockKt, new RegExp(`"${reason}" -> t\\("appLock\\.${reason}"\\)`));
    // General's switch: off sends core's edit at once; on only after the device lock's yes; a no shows core's errors[reason] under the row.
    assert.match(lockKt, /if \(!edit\.getBoolean\("value"\)\) return settings\.general\(edit\)\s+ask\(row\.getJSONObject\("enablePrompt"\)\.getString\("promptMessage"\)\) \{ reason ->\s+if \(reason == null\) shell\.menu\.whenIdle \{ settings\.general\(edit\) \} else settings\.editLocal \{ put\(SWITCH_FAILURE, reason\) \}/);
    assert.match(lockKt, /row\.getJSONObject\("errors"\)\.getString\(it\)/);
    assert.match(settingsUi, /RnSwitch\(lock\.getBoolean\("value"\), model\.failedAction == null && !model\.lock\.authenticating, lock\.getString\("label"\), theme\.generalSwitch\) \{ model\.lock\.toggle\(lock\) \}/);
    assert.match(settingsModel, /"appLock" -> shell\.lock\.stored\(input\.getJSONObject\("edit"\)\.getBoolean\("value"\)\)/);
    // The phone check (findings 6 and 7): each database change happens with the app's process gone, from an untouched pulled copy,
    // staged and size-checked beside the database, the old WAL and SHM removed, then renamed over it; the restore proves core's value,
    // goes back to the tabs, and a failed restore exits 1.
    const lockCheck = readFileSync(resolve(app, 'scripts/check-app-lock-device.mjs'), 'utf8');
    assert.match(lockCheck, /await device\.stopApp\(\);\s+changes \+= 1;\s+const original = pullDatabase\(`original-\$\{changes\}`\);/);
    assert.match(lockCheck, /const staged = Number\(runAs\(`stat -c %s \$\{next\}`\)\);\s+if \(staged !== statSync\(db\)\.size\) fail\([^\n]*\n\s+if \(pid\(\) !== ''\) fail\([^\n]*\n\s+runAs\(`rm -f files\/\$\{DB\}-wal files\/\$\{DB\}-shm`\);\s+runAs\(`mv -f \$\{next\} files\/\$\{DB\}`\);/);
    assert.doesNotMatch(lockCheck, /runAs\(`cp \$\{STAGED\} files\/\$\{DB\}`\)/, 'never copy over the live database in place');
    assert.match(lockCheck, /const now = core\('read'\)\.stored === true;\s+if \(now !== original\) fail\(/);
    assert.match(lockCheck, /await toInbox\(\);[\s\S]{0,200}?RESTORE FAILED[^\n]*\n\s+process\.exitCode = 1;/);
    // No Kotlin policy, dates, colors or literal text; every key a label key; one semantics block per control.
    assert.doesNotMatch(code(lockKt), /\.(sort\w*|sorted\w*|filter(?!Bg\b)\w*|groupBy)\b|SimpleDateFormat|java\.time|\bColor\(|"#[0-9A-Fa-f]{3,8}"/);
    for (const [, key] of code(lockKt).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)"/g)) assert(labelKeys.includes(key), `AppLock.kt: ${key} is not in LABEL_KEYS`);
    for (const [, rest] of code(lockKt).matchAll(/(?:\bText\(|contentDescription = |onClickLabel = )([^\n]*)/g)) {
        for (const [, literal] of rest.replace(/\b(t|testTag|getString|optString|text|getJSONObject|optJSONObject|getBoolean|optBoolean|getInt|menuText|menuObjects)\("[^"]*"\)/g, '').replace(/\btestTag = "[^"]*"/g, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
            if (labelKeys.includes(literal)) continue;
            assert.doesNotMatch(literal.replace(/\$\{[^}]*\}|\$\w+/g, ''), /\p{L}/u, `AppLock.kt: hard-coded UI text "${literal}"`);
        }
    }
    assert.match(lockKt, /\.testTag\("app-lock-unlock"\)\s+\.clearAndSetSemantics \{ contentDescription = label; role = Role\.Button; if \(enabled\) onClick \{ lock\.unlock\(\); true \} else disabled\(\) \}/);
}

// Pass 11: Mind Sweep and a saved search's screen on core's new contracts; the Focus filter pickers' search;
// Bulk organize's project and area pickers that create one.
{
    const sweepKt = source('MindSweep.kt');
    const pass11 = { sweepKt, savedSearchUi };
    // Reads pass Kotlin's input to core unchanged; writes are core's commands, each logged as its operation.
    for (const [name, method] of [['mindSweep', 'getMindSweep'], ['savedSearch', 'getSavedSearchView']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuRead ${name} is core's ${method}`);
    }
    for (const [name, method] of [['bulkCreate', 'createBulkOrganizeDestination'], ['mindSweepAdd', 'addMindSweepItem'], ['savedSearchDelete', 'deleteSavedSearch']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${method}\\(input\\),$`, 'm'), `menuCommand ${name} is core's ${method}`);
    }
    // Every write is MenuModel's send -> perform(action) with its exact FailedAction: core's whole input with the request UUID. The two
    // creates (a Mind Sweep capture, Bulk organize's project or area) are on disk before the call and sent again first after process death.
    assert.match(menuModel, /"bulkCreate", "mindSweepAdd", "savedSearchDelete" -> JSONObject\(action\.title\)\.put\("requestId", action\.id\)/);
    assert.match(sweepKt, /menu\.create\(addAction\(group\.getString\("id"\)\)\)/, 'a Mind Sweep Add is a create: on disk first');
    assert.match(menuModel, /create\(FailedAction\("bulkCreate", UUID\.randomUUID\(\)\.toString\(\), JSONObject\(\)\.put\("list", list\)\.put\("kind", kind\)\.put\("name", name\)/, 'Bulk organize\'s create is a create: on disk first');
    assert.match(menuModel, /shell\.failedAction\?\.takeIf \{ it\.kind == "bulkCreate" \}\?\.let \{ return retry\(it\) \}/, 'an owed create is sent again exactly');
    for (const [name, text] of Object.entries(pass11)) {
        assert.doesNotMatch(code(text), /menuCommand\(|\bsend\(|shell\.perform\(action|FailedAction\((?!"mindSweepAdd")/, `${name}: writes only through MenuModel.command, act or create`);
    }
    // A write core refused, or whose write did not land (ACTION_FAILED, as core's contracts say for these two), owes nothing: Mind Sweep's
    // failure line or the picker's line shows instead of the failure message.
    assert.match(menuModel, /private val LANDLESS = setOf\("mindSweepAdd", "bulkCreate"\)/);
    assert.match(menuModel, /\|\| \(action\.kind in LANDLESS && failure\.message\?\.startsWith\("ACTION_FAILED"\) == true\)/);
    assert.match(menuModel, /if \(refused && action\.kind in LANDLESS\) \{\s+shell\.acknowledged\(action\)\s+shell\.ui \{ landless\(action\) \}\s+return@perform/);
    // Navigation: the Inbox's Mind Sweep (its pill and its empty-Inbox button) and the Weekly Review's open it; the More sheet's saved
    // searches open their screen; Mind Sweep goes back to the screen it opened over.
    assert.equal(code(inboxUi).match(/openMindSweep\(\)/g).length, 2);
    assert.equal(code(weeklyUi).match(/openMindSweep\(\)/g).length, 2);
    assert.match(menuModel, /private fun isSavedSearch\(id: String\) = more\?\.collection\("savedSearches"\)\?\.any \{ it\.getString\("id"\) == id && it\.getString\("route"\)\.startsWith\("\/saved-search\/"\) \} == true/);
    assert.match(menuModel, /else -> if \(isSavedSearch\(id\)\) openSavedSearch\(id\)/);
    assert.match(menuModel, /leave\(if \(flow \|\| over\) MenuScreen\.entries\.firstOrNull \{ it\.name == saved\.get<String>\(if \(over\) "screenFrom" else "reviewFrom"\) \} else null\)/);
    assert.match(menuUi, /MenuScreen\.MindSweep -> MindSweepScreen\(model\)/);
    assert.match(menuUi, /"savedSearch" -> SavedSearchList\(model\)/);
    // Mind Sweep: RN's React state in a synced file while the screen is open (the Bundle names the screen), so rotation and process death
    // keep it; the controls carry core's scope and steps; Add waits for core's view of the text as typed; an answer counts once, for its sweep.
    assert.match(sweepKt, /var state by mutableStateOf\(if \(menu\.screen == MenuScreen\.MindSweep\) stored\(\) \?: fresh\(\) else fresh\(\)\.also \{ file\.delete\(\) \}\)/);
    assert.match(sweepKt, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(value\.toString\(\)\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
    for (const control of ['start', 'back', 'next']) assert.match(sweepKt, new RegExp(`\\{ step\\(${control}\\.getInt\\("step"\\)\\) \\}`), `${control} carries core's step`);
    assert.match(sweepKt, /scope\(option\.getString\("value"\)\)/);
    assert.match(sweepKt, /if \(viewDraft != state\.getString\("draft"\) \|\| group\.getJSONObject\("add"\)\.getBoolean\("disabled"\)\) return/);
    assert.match(sweepKt, /private fun ours\(action: FailedAction\) = menu\.screen == MenuScreen\.MindSweep && state\.getString\("requestId"\) == action\.id/);
    assert.match(sweepKt, /\.put\("state", sent\.getJSONObject\("sweep"\)\)\.put\("draft", sent\.getString\("draft"\)\)\.put\("addFailed", sent\.getBoolean\("addFailed"\)\)/);
    // A saved search: the menu list machinery reads core's view for its ID (windows of 50, More); Delete asks core's question, then RN goes back.
    assert.match(menuModel, /"savedSearch" -> JSONObject\(\)\.put\("id", own\.optString\("id"\)\)/);
    assert.match(savedSearchUi, /confirm\(delete\.getJSONObject\("confirm"\), JSONObject\(\)\.put\("id", view\.getString\("id"\)\), "savedSearchDelete"\)/);
    assert.match(menuModel, /"savedSearchDelete" -> if \(screen == MenuScreen\.SavedSearch && own\("savedSearch"\)\.optString\("id"\) == JSONObject\(action\.title\)\.getString\("id"\)\) closeScreen\(\)/);
    assert.match(savedSearchUi, /TaskRowItem\(model, it, status = RowStatus\.Badge\)/, 'rows keep the lists\' own commands and editor');
    // Correction pass 1 (finding 3): a later window that went stale drops the partial view and reads the whole view again from
    // offset 0, a bounded number of times (then core's failure shows), in Mind Sweep.
    assert.match(sweepKt, /private fun <T> wholeView\(read: \(\) -> T\): T \{\s+repeat\(STALE_READS - 1\) \{\s+try \{\s+return read\(\)\s+\} catch \(failure: Exception\) \{\s+if \(failure\.message\?\.startsWith\("STALE_REVISION"\) != true\) throw failure\s+\}\s+\}\s+return read\(\)/);
    assert.match(sweepKt, /private const val STALE_READS = 3/);
    assert.match(sweepKt, /private fun read\(runtime: CoreHost, sent: JSONObject\): JSONObject = wholeView \{/);
    assert.equal(code(sweepKt).match(/startsWith\("STALE_REVISION"\)/g).length, 1, 'no reader keeps a partial view: only wholeView catches a stale window');
    // Correction pass 1 (finding 4): the device check settles an injected failure it left owed (the exact request, through the app's
    // Try again), waits until the retry lock and the request on disk are gone, and fails loudly when it cannot.
    const sweepCheck = readFileSync(resolve(app, 'scripts/check-sweep-saved-device.mjs'), 'utf8');
    assert.match(sweepCheck, /const restore = async \(\) => \{\s+for \(const name of PROPS\) \{ try \{ setProp\(name, ''\); \} catch \{ \/\* device gone \*\/ \} \}\s+await settleOwed\(\);/);
    assert.match(sweepCheck, /if \(!retry && !pendingOnDisk\(\)\) \{/);
    assert.match(sweepCheck, /RESTORE FAILED: \$\{owed\} is still owed[^\n]*\n\s+process\.exitCode = 1;/);
    assert.equal(sweepCheck.match(/owed = '/g).length, 1, 'the injected failure is named while its retry is owed');
    assert.equal(sweepCheck.match(/(?<!let )owed = null;/g).length, 2, 'and cleared once settled');
    // Focus's filter pickers search as the Inbox's: core's matches from offset zero at Focus's revision; a changed Focus is read again.
    assert.match(focusModelKt, /runtime\.menuRead\("focusList", JSONObject\(\)\.put\("controls", JSONObject\(sent\)\)\.put\("list", name\)\.put\("offset", items\.length\(\)\)\s+\.put\("limit", WINDOW\)\.put\("revision", revision\)\.put\("query", query\)\.toString\(\)\)/);
    assert.match(focusModelKt, /else if \(found == null\) shell\.refreshFocus\(\)/);
    assert.match(focusControlsUi, /LaunchedEffect\(revision, picker\) \{ if \(query\.isNotBlank\(\)\) searchPicker\(picker, query,/);
    // Bulk organize's pickers: core's create row and the keyboard's Done (core's submit, after the text as typed is read); a create
    // answers with core's draft, which the dialog keeps.
    assert.match(bulkUi, /picker\?\.optJSONObject\("create"\)\?\.let \{ create ->/);
    assert.match(bulkUi, /organizeCreate\(create\.getString\("name"\)\)/);
    assert.match(menuModel, /submit\.optJSONObject\("edit"\)\?\.let \{ edit -> organizePicker\(null\); organizeEdit\(edit\) \} \?: submit\.menuText\("create"\)\?\.let\(::organizeCreate\)/);
    assert.match(menuModel, /"bulkCreate" -> dialog\?\.takeIf \{ it\.optString\("kind"\) == "organize" \}\?\.let \{ open ->\s+keepDialog\(JSONObject\(open\.toString\(\)\)\.put\("draft", reply\.getJSONObject\("draft"\)\)/);
    // No Kotlin policy, dates, colors or literal text in the new files; one semantics block per control.
    for (const [name, text] of Object.entries(pass11)) {
        assert.doesNotMatch(code(text), /\.(sort\w*|sorted\w*|filter(?!Bg\b|Edit\b|s\b)\w*|groupBy|reversed|asReversed|shuffled|distinct\w*|partition|minBy|maxBy)\b/, `${name}: no Kotlin sorting, filtering, or grouping`);
        assert.doesNotMatch(code(text), /SimpleDateFormat|DateTimeFormatter|LocalDate|LocalTime|java\.time|java\.util\.Calendar|Calendar\.getInstance|GregorianCalendar|Instant\b|\.format\(|toLocal|currentTimeMillis|\bDate\(|TimeZone/, `${name}: no Kotlin date math, formatting or parsing`);
        assert.doesNotMatch(code(text), new RegExp(`${STATUS}(?:\\s*,\\s*${STATUS})*\\s*->\\s*${STATUS}`), `${name}: no status-to-status map`);
        assert.doesNotMatch(code(text), /\bColor\(|Color\.(Black|White|Red|Green|Blue|Gray|Yellow|Cyan|Magenta|DarkGray|LightGray|Transparent)\b|parseColor|"#[0-9A-Fa-f]{3,8}"|0x[0-9A-Fa-f]{8}/, `${name} writes a color; colors live only in Theme.kt`);
        for (const [, key] of code(text).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)"/g)) assert(labelKeys.includes(key), `${name}: ${key} is not in LABEL_KEYS`);
        for (const [, rest] of code(text).matchAll(/(?:\bText\(|contentDescription = |onClickLabel = )([^\n]*)/g)) {
            for (const [, literal] of rest.replace(/\b(t|testTag|getString|optString|text|getJSONObject|optJSONObject|getBoolean|optBoolean|getInt|menuText|menuObjects)\("[^"]*"\)/g, '').replace(/\btestTag = "[^"]*"/g, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
                if (labelKeys.includes(literal)) continue;
                assert.doesNotMatch(literal.replace(/\$\{[^}]*\}|\$\w+/g, ''), /\p{L}/u, `${name}: hard-coded UI text "${literal}"`);
            }
        }
        // The screens (the composables after each model) reach core only through their model.
        const ui = code(text).slice(Math.max(0, code(text).indexOf('@Composable')));
        assert.doesNotMatch(ui, /runtime\.|menuCommand\(|menuRead\(|shell\.perform/, `${name}: the screen reaches core only through its model`);
        assert.doesNotMatch(code(text), /\.clickable\(enabled = [^\n]*\.semantics \{ contentDescription|\.semantics \{ contentDescription[^\n]*\}\s*\.clickable\(enabled/, `${name}: no control with a clickable and a separate semantics block`);
    }
    assert(code(sweepKt).match(/\.clearAndSetSemantics \{/g).length >= 3);
    assert(code(savedSearchUi).match(/\.clearAndSetSemantics \{/g).length >= 2);
}

// Pass B1 (entry points): RN's activity name as an alias with RN's link, share and assistant intents and RN's app shortcuts, the
// development build's own scheme, and a router that opens what core's resolveNativeEntryPoint names; Import .txt in the popup.
{
    const entryKt = source('EntryPoints.kt');
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const gradle = readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8');
    // The alias is RN's component name (widgets, icons and pinned shortcuts launch it) and carries every public entry point; the
    // activity itself (singleTask, as RN's) has no filter, and nothing runs in another process (one engine, one writer).
    const alias = manifest.match(/<activity-alias\s[\s\S]*?<\/activity-alias>/g) ?? [];
    assert.equal(alias.length, 1, 'one activity alias');
    assert.match(alias[0], /android:name="\$\{applicationId\}\.MainActivity"/);
    assert.match(alias[0], /android:targetActivity="\.MainActivity"/);
    assert.match(alias[0], /android:exported="true"/);
    const filters = alias[0].match(/<intent-filter>[\s\S]*?<\/intent-filter>/g);
    const filter = (action) => filters.find((entry) => entry.includes(`android:name="${action}"`));
    assert.match(filter('android.intent.action.MAIN'), /android\.intent\.category\.LAUNCHER/);
    assert.match(filter('android.intent.action.VIEW'), /category\.DEFAULT[\s\S]*category\.BROWSABLE[\s\S]*<data android:scheme="\$\{urlScheme\}" \/>/);
    assert.match(filter('android.intent.action.SEND'), /category\.DEFAULT[\s\S]*<data android:mimeType="text\/plain" \/>/);
    assert.doesNotMatch(filter('android.intent.action.SEND'), /image|audio|video|application|SEND_MULTIPLE/, 'files wait for the attachments pass');
    assert.match(filter('com.google.android.gms.actions.CREATE_NOTE'), /category\.DEFAULT[\s\S]*category\.VOICE[\s\S]*mimeType="text\/plain"[\s\S]*mimeType="\*\/\*"/);
    assert.match(alias[0], /android:name="android\.app\.shortcuts"\s+android:resource="@xml\/mindwtr_shortcuts"/);
    assert.equal(manifest.match(/category\.LAUNCHER/g).length, 1, 'one launcher entry: the alias');
    const mainActivity = manifest.match(/<activity\s[^>]*android:name="\.MainActivity"[^>]*\/>/)?.[0] ?? assert.fail('MainActivity has no filter of its own');
    assert.match(mainActivity, /android:launchMode="singleTask"/);
    // The activity is not exported: only the alias, with its filters, can start it from another app or the shell, so the
    // device checks launch the alias (RN's component name), never the class.
    assert.match(mainActivity, /android:exported="false"/);
    {
        const { readdirSync } = await import('node:fs');
        for (const name of readdirSync(resolve(app, 'scripts')).filter((file) => file.endsWith('.mjs'))) {
            assert.doesNotMatch(readFileSync(resolve(app, 'scripts', name), 'utf8'), /\/tech\.dongdongbh\.mindwtr\.pilot\.MainActivity/, `${name} launches the unexported class`);
        }
    }
    assert.doesNotMatch(manifest, /android:process=/);
    // D6: each build type's scheme, and the scheme reaches the manifest, the shortcuts and BuildConfig from one map.
    assert.match(gradle, /val urlSchemes = mapOf\("debug" to "mindwtr-native-dev", "upgradetest" to "mindwtr-upgradetest", "release" to "mindwtr"\)/);
    assert.match(gradle, /buildConfigField\("String", "URL_SCHEME", "\\"\$scheme\\""\)\s+manifestPlaceholders\["urlScheme"\] = scheme/);
    for (const type of ['debug', 'release']) assert.match(gradle, new RegExp(`getByName\\("${type}"\\) \\{ urlScheme\\(\\) \\}`));
    assert.match(gradle, /create\("upgradetest"\) \{[^}]*urlScheme\(\)\s+\}/);
    assert.match(gradle, /tasks\.named\("preBuild"\) \{ dependsOn\(buildCoreBundle, buildShortcuts, buildWidgets, rnAttachmentInstaller\) \}/);
    // The bytecode cache's keys (BytecodeCache.kt): the engine version is the QuickJS dependency's, and the bundle carries the
    // SHA-256 of its own body in its first line, written with it in one file (build-bundle.mjs), so a bundle and a hash from
    // two builds cannot pair up. Every variant's merged assets are checked by verify-bundle.mjs before packaging.
    assert.equal(/buildConfigField\("String", "QUICKJS_WRAPPER", "\\"([^"\\]+)\\""\)/.exec(gradle)?.[1],
        /implementation\("wang\.harlon\.quickjs:wrapper-android:([^"]+)"\)/.exec(gradle)?.[1], 'the cache key names the QuickJS wrapper in use');
    {
        const verifier = resolve(app, 'scripts/verify-bundle.mjs');
        const buildBundle = readFileSync(resolve(app, 'scripts/build-bundle.mjs'), 'utf8');
        const verifies = (file) => spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' }).status === 0;
        const bundlePath = resolve(app, 'android/app/src/main/assets/core-host.js');
        const bundle = readFileSync(bundlePath);
        const newline = bundle.indexOf(10);
        assert.match(bundle.subarray(0, newline).toString('utf8'), /^\/\/mindwtr-bundle-sha256:[0-9a-f]{64}$/, 'the bundle starts with its hash line');
        assert(verifies(bundlePath), 'the built bundle matches its own hash line');
        const scratch = mkdtempSync(resolve(tmpdir(), 'bundle-pair-'));
        try {
            const write = (name, bytes) => { writeFileSync(resolve(scratch, name), bytes); return resolve(scratch, name); };
            // A body from another build under this hash line, a changed byte, no hash line, and no file all fail the check.
            assert(!verifies(write('other-body.js', Buffer.concat([bundle.subarray(0, newline + 1), Buffer.from('globalThis.other = 1;')]))), 'another body under the hash line fails');
            const changed = Buffer.from(bundle); changed[changed.length - 2] ^= 1;
            assert(!verifies(write('changed.js', changed)), 'a changed byte fails');
            assert(!verifies(write('no-header.js', bundle.subarray(newline + 1))), 'a bundle without its hash line fails');
            assert(!verifies(resolve(scratch, 'missing.js')), 'a missing bundle fails');
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        assert.match(gradle, /val verifyBundle = [^\n]*verify-bundle\.mjs[\s\S]{0,300}?tasks\.withType<com\.android\.build\.gradle\.tasks\.MergeSourceSetFolders>\(\)\.configureEach \{\s+if \(name\.startsWith\("merge"\) && name\.endsWith\("Assets"\) && !name\.contains\("Test"\)\) \{[\s\S]{0,300}?commandLine\(listOfNotNull\("node", verifyBundle, outputDir\.get\(\)\.asFile\.resolve\("core-host\.js"\)\.path, traced\)\)\s*\}\.result\.get\(\)\.assertNormalExitValue\(\)/, 'every variant\'s merged assets are verified and a mismatch fails the build');
        assert.match(buildBundle, /renameSync\(/, 'the bundle is written under a temporary name and renamed into place');
    }
    // Module instrumentation (build-bundle.mjs --trace-modules) is a measurement build's only: its own output, merged only
    // into the benchmarkTrace variant. The bundle every other variant ships has no module hook, and no environment variable
    // can turn one on.
    {
        const shipped = readFileSync(resolve(app, 'android/app/src/main/assets/core-host.js'), 'utf8');
        assert(!shipped.includes('__mwTraceModule') && !/__MINDWTR_STARTUP_PROFILING__\s*=\s*(true|!0)/.test(shipped), 'the shipped bundle has no module hooks');
        const buildBundle = readFileSync(resolve(app, 'scripts/build-bundle.mjs'), 'utf8');
        assert.doesNotMatch(buildBundle, /process\.env/, 'no environment variable changes the bundle');
        assert.equal(gradle.match(/--trace-modules/g)?.length, 1, 'one Gradle task builds the traced bundle');
        assert.match(gradle, /val buildTracedCoreBundle by tasks\.registering\(Exec::class\) \{[\s\S]{0,300}?"--trace-modules", "--out", tracedBundle\.get\(\)\.asFile\.path/);
        assert.equal(gradle.match(/tracedBundleAssets/g)?.length, 3, 'the traced bundle is declared once, written once, and merged once');
        assert.match(gradle, /getByName\("benchmarkTrace"\)\.assets\.srcDir\(tracedBundleAssets\)/, 'only benchmarkTrace merges it');
        // Both ends refuse a traced bundle anywhere else: build-bundle.mjs will not write one into the shared main assets,
        // and verify-bundle.mjs fails any variant's bundle with module hooks unless Gradle says it is benchmarkTrace's.
        const mainBundle = resolve(app, 'android/app/src/main/assets/core-host.js');
        const before = readFileSync(mainBundle);
        const run = (script, args) => spawnSync(process.execPath, [resolve(app, 'scripts', script), ...args], { encoding: 'utf8' }).status;
        assert.notEqual(run('build-bundle.mjs', ['--trace-modules']), 0, 'no traced bundle without --out');
        assert.notEqual(run('build-bundle.mjs', ['--trace-modules', '--out', mainBundle]), 0, 'no traced bundle into the main assets');
        assert(readFileSync(mainBundle).equals(before), 'the main bundle is untouched by a refused traced build');
        const scratch = mkdtempSync(resolve(tmpdir(), 'traced-bundle-'));
        try {
            const traced = resolve(scratch, 'core-host.js');
            assert.equal(run('build-bundle.mjs', ['--trace-modules', '--out', traced]), 0, 'a traced bundle builds to its own output');
            assert.notEqual(run('verify-bundle.mjs', [traced]), 0, 'a bundle with module hooks fails an ordinary variant');
            assert.equal(run('verify-bundle.mjs', [traced, '--allow-module-trace']), 0, 'benchmarkTrace accepts it');
            assert.equal(run('verify-bundle.mjs', [mainBundle]), 0, 'the ordinary bundle passes');
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        assert.equal(gradle.match(/--allow-module-trace/g)?.length, 1, 'one place allows module hooks');
        // Each channel's benchmarkTrace (mergePlayBenchmarkTraceAssets, mergeFossBenchmarkTraceAssets), no other variant.
        assert.match(gradle, /if \(name\.endsWith\("BenchmarkTraceAssets"\)\) "--allow-module-trace"/, 'only benchmarkTrace\'s merged assets may carry them');
    }
    // RN's shortcuts from RN's own builder: the same ids, capabilities, labels and links, on the build's scheme; Add task opens
    // RN's quick capture dialog in the build's package, as RN's does (pass W1 brings it).
    assert.match(gradle, /urlSchemes\.map \{ \(type, scheme\) -> "\$type=\$scheme@\$\{packages\.getValue\(type\)\}" \}/);
    const { createRequire } = await import('node:module');
    const rnShortcuts = createRequire(import.meta.url)('../../mobile/plugins/android-app-shortcuts.js').__testables;
    const { buildShortcuts } = await import('./build-shortcuts.mjs');
    const ids = (xml) => [...xml.matchAll(/android:shortcutId="([^"]+)"/g)].map(([, id]) => id);
    const capabilities = (xml) => [...xml.matchAll(/<capability android:name="([^"]+)"/g)].map(([, id]) => id);
    for (const [scheme, applicationId] of [['mindwtr-native-dev', 'tech.dongdongbh.mindwtr.nativeclient.dev'], ['mindwtr-upgradetest', 'tech.dongdongbh.mindwtr.upgradetest'], ['mindwtr', 'tech.dongdongbh.mindwtr']]) {
        const { xml, strings } = buildShortcuts(scheme, applicationId);
        const rnXml = rnShortcuts.buildShortcutsXml(applicationId);
        assert.deepEqual(ids(xml), ['capture', 'inbox', 'focus', 'waiting', 'someday', 'projects', 'review', 'calendar', 'add_task_inbox', 'add_task_details', 'open_focus', 'open_calendar']);
        assert.deepEqual(ids(xml), ids(rnXml));
        assert.deepEqual(capabilities(xml), capabilities(rnXml));
        assert.equal(strings, rnShortcuts.SHORTCUTS_STRINGS_XML);
        assert.equal(xml.replaceAll(`${scheme}:///`, 'mindwtr:///'), rnXml, 'RN\'s shortcuts but for the scheme');
        assert.match(xml, new RegExp(`android:targetPackage="${applicationId.replace(/\./g, '\\.')}"\\s+android:targetClass="tech\\.dongdongbh\\.mindwtr\\.androidwidget\\.QuickCaptureActivity"`), 'Add task opens RN\'s dialog');
    }
    // Core's buildCreateNoteCapture mirrors RN's MainActivity (the name, else the Assistant's text, else EXTRA_TEXT; the note when
    // it differs): if RN's rule changes, this fails, and core's mirror must change with it.
    const startupTrace = readFileSync(resolve(app, '../mobile/plugins/android-startup-trace.js'), 'utf8');
    assert.match(startupTrace, /val rawTitle = intent\.getStringExtra\("com\.google\.android\.gms\.actions\.extra\.NAME"\)\?\.trim\(\)\.orEmpty\(\)\s+val rawText = \(\s+intent\.getStringExtra\("com\.google\.android\.gms\.actions\.extra\.TEXT"\)\s+\?: intent\.getStringExtra\(Intent\.EXTRA_TEXT\)\s+\)\?\.trim\(\)\.orEmpty\(\)\s+val title = when \{\s+rawTitle\.isNotBlank\(\) -> rawTitle\s+rawText\.isNotBlank\(\) -> rawText\s+else -> return\s+\}/);
    assert.match(startupTrace, /if \(rawText\.isNotBlank\(\) && rawText != title\) \{\s+builder\.appendQueryParameter\("note", rawText\)/);
    // Kotlin reads the intent's data and text extras as strings only (no stream, no parcel), inside runCatching, and sends them to
    // core unchanged with the build's scheme; the Assistant's extras are RN's.
    const intentRead = code(entryKt.slice(entryKt.indexOf('fun Intent.entryInput()'), entryKt.indexOf('fun Context.readPickedText')));
    assert.match(intentRead, /= runCatching \{/);
    assert.match(intentRead, /Intent\.ACTION_VIEW -> dataString\?\.let \{ JSONObject\(\)\.put\("kind", "link"\)\.put\("url", it\)\.put\("scheme", BuildConfig\.URL_SCHEME\) \}/);
    assert.match(intentRead, /Intent\.ACTION_SEND -> if \(type\?\.startsWith\("text\/plain"\) != true\) null else/);
    assert.match(intentRead, /\.extra\("text", getStringExtra\(Intent\.EXTRA_TEXT\)\)\.extra\("title", getCharSequenceExtra\(Intent\.EXTRA_TITLE\)\?\.toString\(\)\)\s+\.extra\("subject", getStringExtra\(Intent\.EXTRA_SUBJECT\)\)/);
    assert.match(intentRead, /\.extra\("text", getStringExtra\(NOTE_TEXT\)\)\.extra\("extraText", getStringExtra\(Intent\.EXTRA_TEXT\)\)/);
    assert.match(entryKt, /private const val NOTE_NAME = "com\.google\.android\.gms\.actions\.extra\.NAME"\s+private const val NOTE_TEXT = "com\.google\.android\.gms\.actions\.extra\.TEXT"/);
    assert.doesNotMatch(code(entryKt), /EXTRA_STREAM|getParcelable|getSerializable|getBundleExtra/);
    // Entries wait in the persisted FIFO queue (EntryQueue.kt, JVM-tested) from the intent's arrival; the oldest opens only while
    // the app is free, is read in one perform (a capture's popup view too), and opens once the action ends; the editor opens
    // through whenIdle, as it refuses while busy.
    const queueKt = source('EntryQueue.kt');
    assert.match(entryKt, /private val queue = EntryQueue\(dir\)/);
    assert.match(model, /val entries = EntryRouter\(this, File\(app\.noBackupFilesDir, "entries"\)\)/);
    assert.doesNotMatch(code(entryKt), /saved\[|SavedStateHandle/, 'the queue lives on disk, not in the saved state');
    assert.match(entryKt, /if \(!queue\.add\(input\.toString\(\)\)\)/);
    // Any open unsaved work holds the entry back (the capture popup and its draft included): a share never replaces it.
    assert.match(entryKt, /!writable \|\| busy \|\| failedAction != null \|\| editor != null \|\| processing\?\.hidden == false \|\| capture != null \|\| captureModal\.open != null\s+\|\| menu\.dialog != null \|\| menu\.focusControls\.dialog != null \|\| menu\.calendar\.composer != null \|\| search\?\.saveName != null\s+\|\| menu\.screen == MenuScreen\.MindSweep/);
    // Typed text not yet sent holds entries back too: the Add new project field while the Projects list shows it, and a
    // Settings field before its commit (a GTD text field, a Someday section's inline rename).
    assert.match(entryKt, /\|\| \(menu\.screen == MenuScreen\.Settings && menu\.settings\.uncommitted\)\s+\|\| \(projectDraft\.isNotBlank\(\) && openProjectId == null && \(menu\.screen == MenuScreen\.Projects\s+\|\| \(menu\.screen == null && screen == Screen\.Projects && menu\.quickView == "projects"\)\)\)/);
    assert.match(source('SettingsModel.kt'), /val uncommitted: Boolean get\(\) = local\.has\("renaming"\) \|\| local\.keys\(\)\.asSequence\(\)\.any \{ it\.startsWith\("typed:"\) \}/);
    assert.match(entryKt, /val reply = runtime\.menuRead\("entryPoint", entry\.input\)/);
    assert.match(entryKt, /runtime\.openQuickCapture\(\)\s+runtime\.quickCaptureView\(JSONObject\(\)\.put\("text", open\.getString\("text"\)\)\.put\("options", open\.getJSONObject\("options"\)\)\.toString\(\)\)/);
    // An entry leaves the queue only after it opened, or when core refused its input; a failed read keeps it for a later try.
    assert.match(entryKt, /private val lifecycle = EntryLifecycle\(queue\) \{ SystemClock\.uptimeMillis\(\) \}/);
    assert.match(entryKt, /val entry = lifecycle\.next\(blocked\) \?: return/);
    assert.match(entryKt, /\} catch \(failure: Throwable\) \{\s+ui \{ failed\(entry, failure\.message\) \}\s+\/\/[^\n]*\s+if \(!entryRetryable\(failure\.message\)\) return@perform\s+throw failure\s+\}\s+ui \{ menu\.whenIdle \{ opened\(entry, reply, view\) \} \}/);
    assert.match(entryKt, /is EntryLifecycle\.Failure\.Retry -> main\.postDelayed\(\{ pump\(\) \}, outcome\.delayMs\)\s+is EntryLifecycle\.Failure\.Refused -> \{\s+shell\.showToast\(null, outcome\.notice, \"warning\"\)\s+lifecycle\.dismissed\(entry\)/, 'a refused entry shows its notice before it leaves');
    assert.match(entryKt, /if \(blocked\) \{\s+lifecycle\.deferred\(entry\)\s+return\s+\}\s+open\(reply, view\)\s+lifecycle\.opened\(entry\)/);
    assert.doesNotMatch(code(entryKt), /queue\.remove\(/, 'only EntryLifecycle takes an entry out of the queue');
    assert.equal(code(source('EntryLifecycle.kt')).match(/queue\.remove\(/g).length, 2, 'an entry leaves only after it opened, or when core refused its input');
    assert.match(readFileSync(resolve(app, 'android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EntryLifecycleTest.kt'), 'utf8'), /fun severalQueuedEntriesOpenInOrderAcrossARestart\(\)/);
    assert.match(queueKt, /fun entryRetryable\(message: String\?\): Boolean = message\?\.startsWith\("INVALID_INPUT"\) != true/);
    assert.match(queueKt, /out\.fd\.sync\(\)\s+\}\s+check\(partial\.renameTo\(file\)\)/);
    assert.match(readFileSync(resolve(app, 'android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EntryQueueTest.kt'), 'utf8'), /fun aSecondEntryNeverReplacesTheFirst\(\)/);
    assert.match(entryKt, /highlight\(id\); menu\.whenIdle \{ openEditor\(id, "view"\) \}/);
    assert.match(activity, /if \(savedInstanceState == null\) model\.entries\.receive\(intent\)/);
    assert.match(activity, /override fun onNewIntent\(intent: Intent\) \{\s+super\.onNewIntent\(intent\)\s+setIntent\(intent\)\s+model\.entries\.receive\(intent\)/);
    assert.match(activity, /LaunchedEffect\(entries\.head, entries\.blocked\) \{ entries\.pump\(\) \}/);
    assert.match(activity, /LaunchedEffect\(leaveApp\) \{ if \(leaveApp\) \{ leftApp\(\); moveTaskToBack\(true\) \} \}/);
    assert.match(hostEntry, /^\s+entryPoint: \(input\) => logEntryPoint\(input, isNotificationTap\(input\) \? notificationEntry\(input\) : contract\.resolveNativeEntryPoint\(input\)\),$/m);
    // A notification tap (pass R1): core routes it (routeNotificationOpen); only this app's notifications carry the extra.
    assert.match(hostEntry, /const result = contract\.routeNotificationOpen\(payload\);/);
    assert.match(entryKt, /getStringExtra\(CoreNotifications\.EXTRA_OPEN\)\?\.let \{ data -> return@runCatching JSONObject\(\)\.put\("kind", "notification"\)\.put\("data", JSONObject\(data\)\) \}/);
    assert.match(hostEntry, /^\s+captureImport: \(input\) => contract\.planQuickCaptureImport\(input\),$/m);
    assert.ok(hostEntry.includes("releaseCheck: 'v1.3.3/native-android-entry-point', kind, outcome }"));
    // A system capture (RN's origin=system) opens the capture screen, which puts the app behind the previous one; the popup opens
    // only in the app (the + button, the capture feature), so it carries no such flag.
    assert.doesNotMatch(code(captureUi + model + entryKt), /returnToPreviousApp(?!"\))/, 'the popup has no return-to-previous-app path');
    assert.doesNotMatch(readFileSync(resolve(app, '../../packages/core/src/native-host-contract-entry-points.ts'), 'utf8'), /returnToPreviousApp/);
    // Import .txt: RN's text/plain picker; the file is read inside the action (off the main thread) and core plans it; Create tasks
    // sends the file's text, on disk with the question.
    assert.match(captureUi, /rememberLauncherForActivityResult\(ActivityResultContracts\.OpenDocument\(\)\) \{ uri -> uri\?\.let\(::importCaptureText\) \}/);
    assert.match(captureUi, /ImportTextButton\(!locked\) \{ importText\.launch\(arrayOf\("text\/plain"\)\) \}/);
    assert.match(captureUi, /\.clearAndSetSemantics \{ contentDescription = label; role = Role\.Button; testTag = "capture-import-text"; if \(enabled\) onClick \{ pick\(\); true \} else disabled\(\) \}/);
    assert.match(model, /perform \{ runtime ->\s+val text = getApplication<Application>\(\)\.readPickedText\(uri\)\s+val plan = runtime\.menuRead\("captureImport"/);
    assert.match(model, /FailedAction\("captureLines", current\.lineIds\.first\(\), current\.linesText \?: current\.text,/);
    for (const key of ['quickAdd.bulkImportTextFile', 'quickAdd.bulkImportTextFileLabel']) assert(labelKeys.includes(key), `LABEL_KEYS lacks ${key}`);
    // No Kotlin policy, dates, colors or literal text in the new file; RN's route names map to this app's screens only.
    const entryCode = code(entryKt).replace(/private const val \w+ = "[^"]*"/g, '');
    assert.doesNotMatch(entryCode, /\.(sort\w*|sorted\w*|filter\w*|groupBy|reversed|distinct\w*|partition)\b/, 'EntryPoints.kt: no Kotlin sorting, filtering, or grouping');
    assert.doesNotMatch(entryCode, /SimpleDateFormat|DateTimeFormatter|java\.time|Calendar\.getInstance|currentTimeMillis|\bDate\(|\bColor\(|"#[0-9A-Fa-f]{3,8}"/);
    for (const [, key] of entryCode.matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)"/g)) assert(labelKeys.includes(key), `EntryPoints.kt: ${key} is not in LABEL_KEYS`);
    assert.doesNotMatch(entryCode, /\bText\(|contentDescription|showToast\("/, 'EntryPoints.kt: every word is core\'s');
}

// Pass A4 (L1): RN's diagnostics log (files/logs/mindwtr.log) written by core's diagnostics-log.ts through Kotlin's file bridge,
// and Settings › Data's Diagnostics card on core's getDataSettings.
{
    const coreLog = readFileSync(resolve(app, '../../packages/core/src/diagnostics-log.ts'), 'utf8');
    const relative = /export const DIAGNOSTICS_LOG_RELATIVE_PATH = '([^']+)'/.exec(coreLog)[1];
    assert.equal(relative, 'logs/mindwtr.log', 'RN\'s log path, relative to its documents directory (Android files/)');
    assert.match(logFileKt, new RegExp(`const val RELATIVE_PATH = "${relative}"`), 'Kotlin\'s log path is core\'s');
    assert.match(owner, /File\(app\.filesDir, DiagnosticsLogFile\.RELATIVE_PATH\)/);
    // Plain IO only: one unbuffered append per line (a kill keeps every returned line), a replace through a synced rename.
    assert.match(logFileKt, /"append" -> \{\s+FileOutputStream\(file, true\)\.use \{ it\.write\(text\.toByteArray\(\)\) \}/);
    assert.match(logFileKt, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(text\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
    assert.doesNotMatch(code(logFileKt), /[Bb]uffered|appendText|JSONObject|loggingEnabled|500_?000|mindwtr-native-dev/, 'Kotlin holds no log policy');
    assert.match(coreHost, /val logs = DiagnosticsLogFile\(logFile\)\s+bridge\.setProperty\("logFile", guarded \{ args -> logs\.run\(/);
    assert.match(coreHost, /fun logShare\(\): JSONObject = callAsync\("logShare"\)/);
    assert.match(coreHost, /fun logClear\(\): JSONObject = callAsync\("logClear"\)/);
    // Core's logger writes through the file port; the gate reads the store's setting, as RN's isLoggingEnabled does.
    assert.match(hostEntry, /setLogger\(\(payload\) => \{\s+consoleLogger\(payload\);\s+try \{\s+void diagnosticsLog\.append\(diagnosticsEntryFromLogPayload\(payload\), \{ force: payload\.force \}\);/);
    assert.match(hostEntry, /isEnabled: \(\) => isDiagnosticsLoggingEnabled\(useTaskStore\.getState\(\)\.settings\),\s+files: \[nativeLogFile\],/);
    const shareBody = hostEntry.slice(hostEntry.indexOf('    logShare(): string {'), hostEntry.indexOf('    logClear(): string {'));
    assert.match(shareBody, /diagnosticsLog\.serialize\(\(\) => diagnosticsLog\.ensurePath\(\)\)/);
    const markerAt = shareBody.indexOf("logInfo('Native iOS diagnostics share requested'");
    assert(markerAt >= 0 && markerAt < shareBody.indexOf('diagnosticsLog.serialize'), 'iOS marker queues before the final export barrier');
    assert.match(shareBody, /__mindwtrHostPlatform === 'ios'/);
    assert.match(shareBody, /force: true/);
    assert(shareBody.includes("context: { releaseCheck: 'v1.3.4/ios-diagnostics', operation: 'share' }"));
    const clearBody = hostEntry.slice(hostEntry.indexOf('    logClear(): string {'), hostEntry.indexOf('    archiveTaskSelection(json: string)'));
    assert.doesNotMatch(clearBody, /logInfo\(|logWarn\(|diagnosticsLog\.append\(/, 'Clear cannot append a line that recreates its target');
    assert.match(clearBody, /logClearChecked\(\): string \{\s+return submit\(\(\) => diagnosticsLog\.clearChecked\(\)\);/);
    assert.match(hostEntry, /logClear\(\): string \{\s+return submit\(async \(\) => \{\s+await diagnosticsLog\.clear\(\);/);
    // Direct log payloads require context; the shared entry builder accepts extra and sanitizes it into context.
    const checkDiagnosticFields = (source) => {
        const visit = (node) => {
            if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === 'extra') {
                const object = node.parent, call = object.parent;
                assert(ts.isCallExpression(call) && call.expression.getText() === 'buildDiagnosticsLogEntry'
                    && call.arguments[2] === object, 'Direct diagnostic payloads must use context');
            }
            ts.forEachChild(node, visit);
        };
        visit(ts.createSourceFile('host-entry.ts', source, ts.ScriptTarget.Latest, true));
    };
    assert.throws(() => checkDiagnosticFields('diagnosticsLog.append({ extra: { outcome: "lost" } });'));
    assert.throws(() => checkDiagnosticFields('diagnosticsLog.append({ message, extra });'));
    checkDiagnosticFields(hostEntry);
    assert.match(hostEntry, /^\s+dataSettings: \(\) => contract\.getDataSettings\(\),$/m);
    assert.match(hostEntry, /^\s+dataSetting: \(input\) => contract\.setDataSetting\(input\),$/m);
    // Share log: only the logs folder is shareable, through a private FileProvider and the system share sheet; nothing is sent by the app.
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /<provider\s+android:name="androidx\.core\.content\.FileProvider"\s+android:authorities="\$\{applicationId\}\.diagnostics"\s+android:exported="false"\s+android:grantUriPermissions="true">/);
    const paths = readFileSync(resolve(app, 'android/app/src/main/res/xml/diagnostics_paths.xml'), 'utf8');
    assert.deepEqual(paths.match(/<[\w-]+-path [^>]*>/g), ['<files-path name="logs" path="logs/" />']);
    const settingsModelKt = source('SettingsModel.kt');
    const share = code(settingsModelKt.slice(settingsModelKt.indexOf('fun shareLog()'), settingsModelKt.indexOf('fun clearLog()')));
    assert.match(share, /FileProvider\.getUriForFile\(activity, "\$\{activity\.packageName\}\.diagnostics", File\(path\)\)/);
    assert.match(share, /Intent\(Intent\.ACTION_SEND\)\.setType\("text\/plain"\)\.putExtra\(Intent\.EXTRA_STREAM, uri\)\s+\.addFlags\(Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/);
    assert.equal(share.match(/startActivity\(/g).length, 1);
    assert.match(share, /activity\.startActivity\(Intent\.createChooser\(send, null\)\)/, 'the share sheet from the activity, as RN\'s expo-sharing: the user picks where it goes');
    assert.doesNotMatch(share, /FLAG_ACTIVITY_NEW_TASK|getApplication/, 'never a new task from the application context');
    // The made file waits as screen state; the Data screen opens the sheet from its own activity, so a rotation keeps it.
    assert.match(share, /logToShare = path/);
    for (const word of ['logMissing', 'shareUnavailable']) assert.match(share, new RegExp(`words\\.getString\\("${word}"\\)`), `RN's ${word} toast, core's words`);
    assert.match(settingsModelKt, /fun data\(edit: JSONObject\) = menu\.command\("dataSetting", JSONObject\(\)\.put\("edit", edit\)\)/);
    // The Data screen draws core's view: the switch sends core's edit; Share and Clear show only when core sends them.
    const settingsUiKt = source('SettingsScreen.kt');
    const data = code(settingsUiKt.slice(settingsUiKt.indexOf('private fun DataSettings('), settingsUiKt.indexOf('private fun ActionRow(')));
    // The Debug logging switch takes ToggleRow's default: SettingToggleRow's pair, which RN's switch sets itself (checked below).
    assert.match(data, /ToggleRow\(model, diagnostics\.getJSONObject\("debugLogging"\), true\) \{ settings\.data\(it\) \}/);
    assert.match(data, /diagnostics\.optJSONObject\("shareLog"\)\?\.let/);
    assert.match(data, /val activity = LocalActivity\.current\s+LaunchedEffect\(settings\.logToShare\) \{ if \(settings\.logToShare != null\) activity\?\.let\(settings::openShareSheet\) \}/);
    assert.match(data, /diagnostics\.optJSONObject\("clearLog"\)\?\.let/);
    assert.doesNotMatch(data, /\bt\(|"settings\./, 'every word is the view\'s');
    // Review 2026-09-28. (1) RN draws this heading in tc.text (General's are secondaryText).
    const rnDataCard = readFileSync(resolve(app, '../../apps/mobile/components/settings/sync-settings-sections.tsx'), 'utf8');
    assert.match(rnDataCard, /style=\{\[styles\.sectionTitle, \{ color: tc\.text, marginTop: 24 \}\]\}>\{t\('settings\.diagnostics'\)\}/);
    assert.match(data, /SectionTitle\(diagnostics\.getString\("title"\), top = 24, color = c\.text\)/);
    // (3) Share and Clear touch no app data: they run in every state, as RN's do (a tester needs the log most after a failed save).
    assert.match(data, /ActionRow\(share\.getString\("label"\), share\.getString\("description"\), c\.tint, true, "settings-share-log"\)/);
    assert.match(data, /ActionRow\(clear\.getString\("label"\), null, c\.secondaryText, true, "settings-clear-log"\)/);
    const clear = code(settingsModelKt.slice(settingsModelKt.indexOf('fun clearLog()'), settingsModelKt.indexOf('\n    }\n', settingsModelKt.indexOf('fun clearLog()'))));
    for (const body of [share, clear]) {
        assert.match(body, /shell\.anyTime\(\{ runtime ->/);
        assert.doesNotMatch(body, /perform|background\(/);
    }
    assert.match(model, /internal fun anyTime\(work: \(CoreHost\) -> Unit, failed: \(Throwable\) -> Unit\) \{\s+val runtime = host \?: return/);
    // (6) A Share answered after the Data screen closed opens nothing on a later visit.
    assert.match(share, /screen == "data" && menu\.list == "settings" -> logToShare = path/);
    for (const fn of ['fun reset()', 'fun push(', 'fun back()']) {
        const at = settingsModelKt.indexOf(fn);
        assert.match(settingsModelKt.slice(at, settingsModelKt.indexOf('\n    }\n', at)), /logToShare = null/, `${fn} drops a pending share`);
    }
    // (5) RN's settingInfo keeps 16dp to its right.
    const actionRow = code(settingsUiKt.slice(settingsUiKt.indexOf('private fun ActionRow('), settingsUiKt.indexOf('\n}\n', settingsUiKt.indexOf('private fun ActionRow('))));
    assert.match(actionRow, /Column\(Modifier\.padding\(end = 16\.dp\)\)/);
    // (2, 7) Kotlin's file: a file core cannot read is moved aside whole; a folder where the log should be is removed, as RN does.
    assert.match(logFileKt, /"moveAside" -> \{\s+val aside = File\(file\.parentFile, "\$\{file\.name\}\.unreadable"\)\s+aside\.delete\(\)\s+check\(file\.renameTo\(aside\)\)/);
    assert.match(logFileKt, /if \(file\.isDirectory\) file\.deleteRecursively\(\)\s+file\.createNewFile\(\)/);
    assert.match(logFileKt, /file\.isDirectory -> \{ file\.deleteRecursively\(\); "" \}/);
    assert.match(hostEntry, /moveAside: async \(\) => \{ logFile\('moveAside'\); \},/);
}

// Every native switch draws RN's Switch on Android (ReactSwitch over AppCompat 1.7.0's SwitchCompat) for the props its RN call
// site sets. RN multiplies SwitchCompat's opaque track image by trackColor, so the track is that color, solid. Without
// thumbColor the thumb is AppCompat's (colorAccent on, colorSwitchThumbNormal off, the disabled color when disabled), by the
// system's night mode. Nothing fades.
{
    const rnSource = (file) => readFileSync(resolve(app, '../../apps/mobile', file), 'utf8');
    const props = (name) => new RegExp(`val ${name} = RnSwitchProps\\(([^\\n]*)\\)\\n`).exec(themeKt)?.[1] ?? '';
    // SettingToggleRow's default: GTD's switches, and Data's Debug logging, which sets the same pair itself.
    const legacy = /LEGACY_SWITCH_TRACK_COLOR = \{ false: '(#\w{6})', true: '(#\w{6})' \}/.exec(rnSource('components/settings/setting-row.tsx'));
    assert.equal(props('settingsSwitch'), `rgb("${legacy[1].toUpperCase()}"), rgb("${legacy[2].toUpperCase()}")`);
    const rnDebug = /<Switch value=\{loggingEnabled\} onValueChange=\{toggleDebugLogging\} ([^/]*)\/>/.exec(rnSource('components/settings/sync-settings-sections.tsx'))?.[1] ?? '';
    assert.equal(rnDebug.trim(), `trackColor={{ false: '${legacy[1]}', true: '${legacy[2]}' }}`, 'RN\'s Debug logging switch sets only SettingToggleRow\'s pair');
    const gtd = rnSource('components/settings/gtd-settings-screen.tsx');
    assert(gtd.includes('<SettingToggleRow') && !/trackColor|thumbColor/.test(gtd), 'RN\'s GTD switches keep SettingToggleRow\'s default');
    // General's three switches: trackColor { false: secondaryText, true: tint }, no thumbColor.
    const general = rnSource('components/settings/general-settings-screen.tsx');
    assert.equal(general.match(/trackColor=\{\{ false: tc\.secondaryText, true: tc\.tint \}\}/g)?.length, 3);
    assert.doesNotMatch(general, /thumbColor/);
    assert.equal(props('generalSwitch'), 'colors.secondaryText, colors.tint');
    // The capture popup's Add another sets both.
    assert.match(rnSource('components/quick-capture-sheet/QuickCaptureSheetBody.tsx'), /thumbColor=\{addAnother \? tc\.tint : tc\.border\}\s+trackColor=\{\{ false: tc\.border, true: `\$\{tc\.tint\}55` \}\}/);
    assert.equal(props('captureSwitch'), 'colors.border, tintTrack, colors.border, colors.tint');
    assert.match(themeKt, /val tintTrack = colors\.tint\.copy\(alpha = 0x55 \/ 255f\)/);
    // Reference's filter sheet (task-list.tsx).
    assert.match(rnSource('components/task-list.tsx'), /trackColor=\{\{ false: themeColors\.border, true: themeColors\.tint \}\}/);
    assert.equal(props('referenceSwitch'), 'colors.border, colors.tint');
    // AppCompat 1.7.0's thumb: switch_thumb_disabled_material, colorAccent (material_deep_teal_500 / _200), colorSwitchThumbNormal.
    assert.match(themeKt, /!enabled -> if \(systemDark\) rgb\("#616161"\) else rgb\("#BDBDBD"\)\s+on -> if \(systemDark\) rgb\("#80CBC4"\) else rgb\("#008577"\)\s+else -> if \(systemDark\) rgb\("#BDBDBD"\) else rgb\("#F1F1F1"\)/);
    // The drawing: the track solid in RN's color, the thumb RN's or AppCompat's, and no fade.
    const graphicAt = captureUi.indexOf('internal fun RnSwitchGraphic(');
    const graphic = code(captureUi.slice(graphicAt, captureUi.indexOf('\n}\n', graphicAt)));
    assert.match(graphic, /background\(if \(on\) props\.trackOn else props\.trackOff\)/);
    assert.match(graphic, /theme\.switchThumbShade\(\(if \(on\) props\.thumbOn else props\.thumbOff\) \?: theme\.switchThumb\(on, enabled, isSystemInDarkTheme\(\)\)\)/);
    // SwitchCompat's thumb image is #FAFAFA (AppCompat 1.7.0's abc_btn_switch_to_on_mtrl), multiplied by the thumb color.
    assert.match(themeKt, /private const val THUMB_IMAGE = 250f \/ 255f/);
    assert.match(themeKt, /Color\(red = color\.red \* THUMB_IMAGE, green = color\.green \* THUMB_IMAGE, blue = color\.blue \* THUMB_IMAGE, alpha = color\.alpha\)/);
    const rnSwitch = code(captureUi.slice(captureUi.indexOf('internal fun RnSwitch('), graphicAt));
    assert.doesNotMatch(rnSwitch + graphic, /fade\(|alpha/, 'RN never fades a disabled switch');
    // RN's SwitchCompat as measured on the S23 (3x, parity pairs popup-another and popup-empty): a 140x81px view, a 71px x 42px
    // track, a 60px thumb whose center moves 59px.
    assert.match(graphic, /Box\(Modifier\.size\(46\.67\.dp, 27\.dp\), contentAlignment = Alignment\.Center\)/);
    assert.match(graphic, /Box\(Modifier\.size\(24\.dp, 14\.dp\)/);
    assert.match(graphic, /offset\(x = if \(on\) 10\.dp else \(-10\)\.dp\)\.size\(20\.dp\)/);
    // Each call site passes its RN props: General's three, the capture popup, Reference's sheet; GTD and Data take the default.
    const settingsUiKt = code(source('SettingsScreen.kt'));
    assert.equal(settingsUiKt.match(/theme\.generalSwitch/g)?.length, 3);
    assert.match(settingsUiKt, /props: RnSwitchProps = LocalTheme\.current\.settingsSwitch/);
    assert.match(code(captureUi), /RnSwitch\(on, enabled = !locked, label = label, props = theme\.captureSwitch\)/);
    assert.match(code(menuUi), /RnSwitchGraphic\(on, true, LocalTheme\.current\.referenceSwitch\)/);
    assert.doesNotMatch(code(menuUi), /fun RnSwitch\(/, 'one switch drawing');
}

// RN dims the capture popup's Save and Save and edit to half, the whole button, and makes them inert while the text is
// blank. The fade is a layer over the whole pill, so it comes before the pill's background and border, not after them.
{
    const rnSheet = readFileSync(resolve(app, '../../apps/mobile/components/quick-capture-sheet/QuickCaptureSheetBody.tsx'), 'utf8');
    assert.equal(rnSheet.match(/opacity: value\.trim\(\) && !saving \? 1 : 0\.5/g)?.length, 2);
    assert.equal(rnSheet.match(/disabled=\{saving \|\| !value\.trim\(\)\}/g)?.length, 2);
    const buttons = code(captureUi).match(/Box\(Modifier\.fade\(if \(canSave\) 1f else 0\.5f\)\.widthIn\(min = 1(12|04)\.dp\)[^\n]*/g) ?? [];
    assert.equal(buttons.length, 2, 'Save and edit and Save fade as a whole');
    assert.doesNotMatch(code(captureUi), /\.clickable\(enabled = canSave[^\n]*\n[^\n]*\.fade\(/, 'no fade after a pill\'s background');
    assert.match(readFileSync(resolve(app, '../../packages/core/src/quick-capture-model.ts'), 'utf8'), /canSave: Boolean\(text\.trim\(\)\)/);
}

// RN's settingRow is alignItems 'flex-start': a row's switch, chevron or field sits at the top beside its label, not centered.
{
    const rnStyles = readFileSync(resolve(app, '../../apps/mobile/components/settings/settings.styles.ts'), 'utf8');
    assert.match(rnStyles, /settingRow: \{[^}]*alignItems: 'flex-start',/);
    const settingsKt = source('SettingsScreen.kt');
    const row = code(settingsKt.slice(settingsKt.indexOf('private fun SettingRow('), settingsKt.indexOf('\n}\n', settingsKt.indexOf('private fun SettingRow('))));
    assert.match(row, /\.padding\(16\.dp\),\s+verticalAlignment = Alignment\.Top\)/, 'SettingRow aligns its trailing control to the top, as RN');
}

// A fade is a layer over what comes after it in a modifier chain. A fade after a background or border leaves them at full
// strength (the capture popup's Save stayed full blue), while RN's opacity dims the whole button. Every fade comes first.
{
    const pilot = resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot');
    const blank = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
    const late = [];
    for (const name of readdirSync(pilot).filter((file) => file.endsWith('.kt'))) {
        const text = blank(readFileSync(resolve(pilot, name), 'utf8'));
        for (const match of text.matchAll(/\.fade\(/g)) {
            // Walk back to the start of this chain: an open bracket, or a comma, `=` or `;` outside brackets.
            let depth = 0;
            let at = match.index;
            while (--at >= 0) {
                const char = text[at];
                if (char === ')' || char === '}') depth++;
                else if (char === '(' || char === '{') { if (depth === 0) break; depth--; }
                else if (depth === 0 && /[,=;]/.test(char)) break;
            }
            if (/\.(background|border)\(/.test(text.slice(at + 1, match.index))) late.push(`${name}:${text.slice(0, match.index).split('\n').length}`);
        }
    }
    assert.deepEqual(late, [], `a fade after a background or border: ${late.join(', ')}`);
}

// The capture screen (pass B1b): RN's capture-modal.tsx on core's capture screen contract (native-host-contract-capture-modal.ts).
// Links, shares, assistant notes and capture-quick open it with the route params core's entry answer carries (a link's tags and
// project stay the screen's props); the + button keeps the popup, as RN. Its open, edits and Cancel are Menu reads; Save and
// Create tasks are journaled task commands, each request on disk before its call and sent again exactly after process death.
{
    const modalKt = captureModalModel;
    const entryKt = source('EntryPoints.kt');
    for (const [name, call] of [['captureModalOpen', 'openCaptureModal'], ['captureModalView', 'getCaptureModalView'], ['captureModalEdit', 'editCaptureModal'],
        ['captureModalDiscard', 'discardCaptureModal']]) {
        assert.match(hostEntry, new RegExp(`^\\s+${name}: \\(input\\) => contract\\.${call}\\(input\\),$`, 'm'), `${name} is a Menu read`);
    }
    for (const [method, operation, call] of [['captureModalSubmit', 'captureModal', 'submitCaptureModal'], ['captureModalLines', 'captureModalLines', 'submitCaptureModalLines']]) {
        assert.match(hostEntry, new RegExp(`${method}\\(json: string\\): string \\{\\s*return submit\\(async \\(\\) => taskResult\\('${operation}', await contract\\.${call}\\(JSON\\.parse\\(json\\)\\)\\)\\);`));
        assert.match(coreHost, new RegExp(`fun ${call}\\(json: String\\): JSONObject = callAsync\\("${method}", json\\)`), `CoreHost.${call} reaches ${method}`);
        assert.match(modalKt, new RegExp(`runtime\\.${call}\\(request\\)`));
    }
    assert.match(hostEntry, /entry\.captureModal \? 'captureModal'/, 'the entry-point line says the capture screen opened');
    // The entry's screen opens in the same perform as core's answer, on the answer's own params; an open screen holds entries back.
    assert.match(entryKt, /reply\.optJSONObject\("captureModal"\)\?\.let \{ modal ->\s+runtime\.menuRead\("captureModalOpen", JSONObject\(\)\.put\("params", modal\.getJSONObject\("params"\)\)\.toString\(\)\)/);
    assert.match(entryKt, /reply\.optJSONObject\("captureModal"\)\?\.let \{ captureModal\.opened\(it\.getJSONObject\("params"\), view \?: return\) \}/);
    // Save and Create tasks: the exact request on disk before the call; a retry reuses it; a refusal frees the capture UUIDs.
    assert.match(modalKt, /private fun send\(action: FailedAction\) = shell\.perform\(action\) \{ runtime ->/);
    assert.equal(code(modalKt).match(/keep\(current\.copy\(pending = action, [^\n]*\)\)\s+send\(action\)/g)?.length, 2, 'Save and Create tasks persist their request first');
    // While a request is owed, Save and Create tasks send that exact request again, whichever it was.
    assert.equal(code(modalKt).match(/val action = current\.pending \?: FailedAction\(/g)?.length, 2, 'a retry reuses the pending request');
    // A failed save closes the several-lines question, as RN's does; the card shows the failure, and the banner's Try again the retry.
    assert.match(modalKt, /keep\(if \(refused\) current\.copy\(pending = null, captureId = UUID\.randomUUID\(\)\.toString\(\), confirm = null, lineIds = emptyList\(\)\) else current\.copy\(confirm = null\)\)/);
    assert.match(modalKt, /shell\.acknowledged\(action\)/);
    assert.match(modalKt, /val refused = UPDATE_REFUSALS\.any \{ failure\.message\?\.startsWith\(it\) == true \}/);
    // ACTION_FAILED: core wrote no task and the journal dropped the entry, so, as RN, the card shows the failure and the next Save
    // is a fresh attempt (as MenuModel's LANDLESS); nothing is owed.
    assert.match(modalKt, /if \(failure\.message\?\.startsWith\("ACTION_FAILED"\) == true\) \{\s+shell\.acknowledged\(action\)\s+shell\.ui \{ failed\(refused = true\) \}\s+return@perform\s+\}/);
    // Cancel (and Back) stay usable while a save is owed: the screen closes, and the exact retry stays owed on the tabs' banner
    // (the journal replays it at the next boot anyway, so it is never dropped).
    assert.match(modalKt, /if \(shell\.failedAction != null\) \{ keep\(null\); inFlight = null; return \}/);
    assert.match(captureModalUi, /control\(actions\.getString\("cancel"\), "capture-modal-cancel", !model\.busy\)/);
    assert.match(captureModalUi, /BackHandler \{\s+if \(model\.busy\) return@BackHandler/);
    // A refusal wrote nothing, so a refused retry of an owed save settles it: the screen unlocks (as the popup's freeCapture).
    assert.match(modalKt, /if \(refused\) shell\.acknowledged\(action\)\s+shell\.ui \{ failed\(refused\) \}/);
    // The Bundle holds only whether the screen is open; the screen itself is on disk, each write synced and renamed into place.
    assert.match(modalKt, /saved\["captureModal"\] = value != null/);
    assert.match(modalKt, /FileOutputStream\(partial\)\.use \{ out -> out\.write\(text\.toByteArray\(\)\); out\.fd\.sync\(\) \}\s+check\(partial\.renameTo\(file\)\)/);
    assert.match(model, /val captureModal = CaptureModalModel\(this, saved, File\(app\.noBackupFilesDir, "capture-modal"\)\)/);
    // After process death the screen comes back (an owed request is sent again first); an owed failure in this process reopens it.
    assert.match(model, /menu\.start\(sheet\)\s+captureModal\.resume\(\)/);
    // A screen restored from disk shows core's view as core reads it now (the data, the language or the minute may have moved).
    assert.match(modalKt, /keep\(restored\.copy\(edits = restored\.edits \+ READ\)\)/);
    assert.match(modalKt, /runtime\.menuRead\(if \(read\) "captureModalView" else "captureModalEdit", request\.toString\(\)\)/);
    assert.match(model, /if \(action\.kind in CAPTURE_MODAL_KINDS\) captureModal\.restored\(action\)/);
    assert.match(model, /"captureModal", "captureModalLines" -> captureModal\.retry\(action\)/);
    // Every control sends core's own edit; Kotlin builds only the typed fields' edits.
    assert.deepEqual([...new Set([...code(modalKt + captureModalUi).matchAll(/put\("type", "(\w+)"\)/g)].map(([, type]) => type))].sort(), ['setDescription', 'setText']);
    assert.match(captureModalUi, /edit\(help\.getJSONObject\("edit"\)\)/, 'the ? button sends core\'s toggleHelp');
    // Full screen over every other screen, as RN presents its modal route; a system capture ends behind the previous app.
    assert.match(activity, /if \(modal != null && writable\) CaptureModalScreen\(model, modal\)\s+else if \(open != null && writable\) TaskEditorScreen\(model, open\)/);
    assert.match(modalKt, /if \(leave && close\.getBoolean\("returnToPreviousApp"\)\) shell\.leaveApp = true/);
    // Back pops the screen as RN's Back pops its route: the app stays; Cancel and a save end a system capture behind the previous app.
    assert.match(captureModalUi, /if \(modal\.confirm != null\) cancelLines\(\) else cancel\(leave = false\)/);
    // Edge to edge the window no longer shrinks for the keyboard: the screen lifts its card and buttons above it, as RN's
    // KeyboardAvoidingView ('height' on Android) does.
    assert.match(captureModalUi, /Box\(Modifier\.fillMaxSize\(\)\.background\(c\.bg\)\.imePadding\(\)\.semantics \{ testTagsAsResourceId = true \}\.testTag\("capture-modal"\)\)/);
    assert.match(readFileSync(resolve(app, '../mobile/app/capture-modal.tsx'), 'utf8'), /behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/);
    // Save & edit, on the capture screen and the popup, goes where RN's openTaskScreen goes: the task's project on RN's Projects
    // screen, else Focus (outlined), and the task's editor opens there on its Task tab.
    assert.match(model, /internal fun openSavedTask\(taskId: String, projectId: String\?\) = menu\.whenIdle \{\s+closeSearch\(\)\s+menu\.closeSheet\(\)\s+if \(projectId != null\) openFromSearch\(Screen\.Projects, projectId\) else \{ menu\.toTabs\(\); show\(Screen\.Focus\); highlight\(taskId\) \}\s+menu\.whenIdle \{ openEditor\(taskId, "task"\) \}/);
    assert.match(model, /"open" -> \{\s+keepCapture\(null\)\s+openSavedTask\(reply\.getString\("taskId"\), reply\.menuText\("projectId"\)\)/);
    assert.match(modalKt, /shell\.openSavedTask\(reply\.getString\("taskId"\), reply\.menuText\("projectId"\)\)/);
    assert.doesNotMatch(code(model + modalKt), /openEditor\(id, "task"\)/, 'Save & edit never opens the editor over the screen it was on');
    // An owed failure (the screen's own save's, or any other command's) shows the app's failure banner with its exact retry, as
    // every screen's does: without it every control stayed disabled with no Try again.
    assert.match(captureModalUi, /if \(model\.failedAction != null\) Box\(Modifier\.statusBarsPadding\(\)\) \{ FailureBanner\(model\.error\.orEmpty\(\)\) \{ OwedRetry\(model\) \} \}/);
    // RN's multi-line text keeps the font's own line pitch (font padding adds space only above the first line and below the last):
    // the syntax help, the title and the description lines match RN's on the S23 with no line height set (parity pair modal-help).
    assert.match(captureModalUi, /view\.getJSONObject\("help"\)\.text\("text"\)\?\.let \{ Text\(it, style = rnText\(12, 400\), color = c\.secondaryText\) \}/);
    // RN's Save is its fixed blue (capture-modal.tsx styles.save), in every theme.
    assert.match(themeKt, /val captureSave = rgb\("#3B82F6"\)/);
    assert.match(captureModalUi, /background\(theme\.captureSave\)/);
}

// Pass B2 (E2 native): CoreWork, the queue's ports, RN's capture intent and context automation receivers under RN's class names,
// RN's capture intent Kotlin compiled as it is, and GTD › Capture's automation card.
{
    // The main manifest and the debug build's widget overlay (RN's plugins' entries, scripts/build-widgets.mjs; pass W1).
    const { buildManifest } = await import('./build-widgets.mjs');
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8') + buildManifest('tech.dongdongbh.mindwtr.nativeclient.dev', 'Mindwtr Native Dev');
    const gradle = readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8');
    const widgetGradle = readFileSync(resolve(app, 'android/widget/build.gradle.kts'), 'utf8');
    const rnWidget = (name) => readFileSync(resolve(app, '../mobile/modules/android-widget/android/src/main/java/tech/dongdongbh/mindwtr/androidwidget', name), 'utf8');
    const nativeKt = (path) => readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr', path), 'utf8');
    const widgetKt = (name) => readFileSync(resolve(app, 'android/widget/src/main/java/tech/dongdongbh/mindwtr/androidwidget', name), 'utf8');
    // Exported: RN's activity alias, RN's two automation receivers (plugins/android-widget.js, android-manifest-fixes.js), the
    // reminders' reschedule receiver in place of RN's exported AlarmBootReceiver (patch-alarm-notification-gradle.js), and RN's
    // widget components (pass W1's block lists them), nothing else.
    const exported = [...manifest.matchAll(/<(?:activity-alias|activity|receiver|service|provider)\s[^>]*?android:name="([^"]+)"[^>]*?android:exported="true"/g)].map((m) => m[1]).sort();
    assert.deepEqual(exported.filter((name) => !/Widget|TasksWidget|CaptureTileService/.test(name)), ['${applicationId}.MainActivity', '.ReminderRescheduleReceiver', 'tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver',
        'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver'], 'only RN\'s exported components');
    const receiver = (name) => manifest.match(new RegExp(`<receiver\\s+android:name="${name.replace(/\./g, '\\.')}"[\\s\\S]*?</receiver>`))?.[0] ?? assert.fail(`no ${name}`);
    const rnPlugin = readFileSync(resolve(app, '../mobile/plugins/android-widget.js'), 'utf8');
    const rnFixes = readFileSync(resolve(app, '../mobile/plugins/android-manifest-fixes.js'), 'utf8');
    assert.match(rnPlugin, /const CAPTURE_RECEIVER_NAME = `\$\{MODULE_PACKAGE\}\.CaptureIntentReceiver`;/);
    const captureAction = /const CAPTURE_ACTION = '([^']+)'/.exec(rnPlugin)[1];
    assert.deepEqual([...receiver('tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver').matchAll(/<action android:name="([^"]+)"/g)].map((m) => m[1]), [captureAction]);
    assert.match(rnFixes, /const CONTEXT_AUTOMATION_RECEIVER = 'tech\.dongdongbh\.mindwtr\.contextautomation\.ContextAutomationReceiver';/);
    const contextActions = [.../const CONTEXT_INTENT_ACTIONS = \[([^\]]*)\]/.exec(rnFixes)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const contextFilters = receiver('tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver').match(/<intent-filter>[\s\S]*?<\/intent-filter>/g);
    assert.equal(contextFilters.length, 2, 'RN\'s two context filters: without data, and with the mindwtr scheme');
    for (const filter of contextFilters) {
        assert.deepEqual([...filter.matchAll(/<action android:name="([^"]+)"/g)].map((m) => m[1]), contextActions);
        assert.match(filter, /<category android:name="android\.intent\.category\.DEFAULT" \/>/);
    }
    assert.doesNotMatch(contextFilters[0], /<data /);
    assert.match(contextFilters[1], /<data android:scheme="mindwtr" \/>/);
    assert.match(manifest, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/);
    // RN's capture intent Kotlin, its receiver included, compiled as it is in the widget module (pass W1), with RN's tests. No
    // native copy of an RN file: a queued capture wakes CoreWork through the headless task's stand-in, which watches the queue.
    const allowedExclusions = /val rnExcluded = listOf\("AndroidWidgetModule", "CaptureSyncHeadlessService"\)/;
    assert.match(widgetGradle, allowedExclusions, 'only the Expo bridge and the headless task stay out');
    assert.deepEqual(readdirSync(resolve(app, 'android/widget/src/main/java/tech/dongdongbh/mindwtr/androidwidget')), ['CaptureSyncHeadlessService.kt'], 'the module\'s one native file is the headless task\'s stand-in');
    const shim = widgetKt('CaptureSyncHeadlessService.kt');
    assert.match(shim, /object : FileObserver\(queue\.path, FileObserver\.MOVED_TO\)/, 'the stand-in watches RN\'s queue folder for a published item');
    assert.match(shim, /CaptureIntentReceiver\.queuedHook = queued\?\.let \{ \{ context: Context -> start\(context\) \} \}/, 'RN\'s receiver waits for the stored job before its broadcast finishes');
    assert.match(shim, /internal fun queueEvent\(context: Context, event: Int, path: String\?\) \{\s+if \(event and FileObserver\.MOVED_TO != 0 && path\?\.endsWith\("\.json"\) == true\) start\(context\)\s+\}/);
    assert(!existsSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/androidwidget')), 'RN\'s CheckoffStore.kt is compiled in; no native copy is left');
    // The context receiver reads the intent as RN's does; where RN starts its headless task, CoreWork asks core.
    const rnContext = readFileSync(resolve(app, '../mobile/modules/context-automation/android/src/main/java/tech/dongdongbh/mindwtr/contextautomation/ContextAutomationReceiver.kt'), 'utf8');
    const nativeContext = nativeKt('contextautomation/ContextAutomationReceiver.kt');
    const payload = (text) => text.slice(text.indexOf('private data class ContextAutomationPayload('));
    assert.equal(payload(nativeContext), payload(rnContext), 'the context receiver reads the intent as RN\'s');
    for (const name of ['ACTIVATE_CONTEXT_ACTION', 'DEACTIVATE_CONTEXT_ACTION']) {
        const value = (text) => new RegExp(`private const val ${name} = "([^"]+)"`).exec(text)[1];
        assert.equal(value(nativeContext), value(rnContext));
    }
    assert.match(nativeContext, /val payload = runCatching \{ ContextAutomationPayload\.fromIntent\(intent\) \}\.getOrNull\(\) \?: return\s+val outcome = queueTrigger\(payload\.action, payload\.context\) \{ CoreWork\.enqueue\(context\.applicationContext, CoreJob\.CONTEXT, it\) \}/);
    // A trigger is bounded as core bounds it before WorkManager sees it (its Data.build() throws past 10,240 bytes), and an
    // enqueue that throws drops it (ContextTriggerTest).
    const coreTextBound = /const isOptionalText = \(value: unknown\) => value === undefined \|\| value === null \|\| isText\(value, (\d+)\);/
        .exec(readFileSync(resolve(app, '../../packages/core/src/native-host-contract-capture-ingest.ts'), 'utf8'))[1];
    assert.equal(/internal const val MAX_TRIGGER_TEXT = (\d+)/.exec(nativeContext)[1], coreTextBound, 'the trigger bound is core\'s');
    assert.match(nativeContext, /if \(context\.length > MAX_TRIGGER_TEXT\) return "too-long"\s+return if \(runCatching \{ enqueue\(mapOf\("action" to action, "context" to context\)\) \}\.isSuccess\) "queued" else "failed"/);
    // Every job recovers first, as the boot orders it: an owed journal replay, then the drain; a job runs only on finished state.
    const coreJob = source('CoreJob.kt');
    assert.match(coreJob, /val host = boot\(\)\s+if \(!host\.recover\(\) \|\| !host\.drain\(\)\) Outcome\.Retry/);
    assert.match(owner, /fun recover\(runtime: CoreHost\): Boolean \{\s+val owed = failure \?: return true\s+if \(owed\.action\.kind != "journal"\) return false\s+runtime\.replayJournal\(\)\.owed\?\.let \{ return false \}\s+clearFailure\(owed\.action\)\s+return true\s+\}/);
    assert.match(source('CoreWork.kt'), /override fun recover\(\) = ProcessCoreHost\.recover\(host\)\s+override fun drain\(\) = ProcessCoreHost\.recovered\(app, host\)/, 'CoreWork drains through the start order');
    // A drain's owed save (an item stored but not saved or recorded) holds a screen's newer edits back until its replay.
    assert.match(model, /if \(failedAction == null\) ProcessCoreHost\.failure\?\.takeIf \{ it\.action\.kind == "journal" \}\?\.let \{ owed ->\s+failedAction = owed\.action\s+error = owed\.error\s+\}\s+if \(busy \|\| runtime == null/);
    // CoreWork: WorkManager at RN's version, in the app's process; expedited on Android 12+; a debug build's delay only.
    const rnWork = /androidx\.work:work-runtime(?:-ktx)?:([\d.]+)/.exec(readFileSync(resolve(app, '../../node_modules/expo-background-task/android/build.gradle'), 'utf8'))[1];
    assert.match(gradle, new RegExp(`implementation\\("androidx\\.work:work-runtime:${rnWork.replace(/\./g, '\\.')}"\\)`), 'WorkManager at RN\'s version');
    const coreWork = source('CoreWork.kt');
    assert.match(coreWork, /val delayMs = debugProperty\("core_work_delay_ms"\)\.toLongOrNull\(\) \?: 0L/);
    assert.match(coreWork, /else if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) setExpedited\(OutOfQuotaPolicy\.RUN_AS_NON_EXPEDITED_WORK_REQUEST\)/);
    assert.match(coreWork, /fun enqueue\(context: Context, job: String, input: Map<String, String> = emptyMap\(\)\): Operation = enqueue\(context, job, input, ExistingWorkPolicy\.REPLACE\)/, 'a new drain request never waits behind a back-off');
    assert.match(coreWork, /work\.enqueueUniqueWork\(INGEST_WORK, policy, request\)/);
    assert.match(coreWork, /val host = ProcessCoreHost\.get\(app, language\)/, 'the job runs on this process\'s one host');
    // The queue's paths: RN's writer's folder is core's.
    const pendingTs = readFileSync(resolve(app, '../../packages/core/src/pending-captures.ts'), 'utf8');
    assert.equal(/const val DIRECTORY = "([^"]+)"/.exec(rnWidget('PendingCaptureWriter.kt'))[1], /export const PENDING_CAPTURES_DIRECTORY = '([^']+)'/.exec(pendingTs)[1]);
    assert.match(hostEntry, /const QUEUE = `files\/\$\{PENDING_CAPTURES_DIRECTORY\}`;/);
    assert.match(hostEntry, /ingest\(requestId: string\): string \{\s+return submit\(async \(\) => taskResult\('ingest', await contract\.ingestPendingCaptures\(\{ requestId, queue: pendingCaptureQueue, lastApplied: lastAppliedRecord \}\)\)\);/);
    // GTD › Capture: core gets only whether the stored config is on; the token stays in Kotlin.
    const settingsModel = source('SettingsModel.kt');
    assert.match(settingsModel, /input\.put\("captureIntent", JSONObject\(\)\.put\("enabled", it\.getOrNull\(\)\?\.enabled \?: JSONObject\.NULL\)\)/);
    assert.doesNotMatch(settingsModel + hostEntry, /put\("token"|captureToken[^\n]*menuRead|menuCommand[^\n]*token/, 'the token never goes to core');
    assert.match(settingsModel, /CaptureIntentConfigStore\.setEnabled\(shell\.getApplication<Application>\(\), enabled\)/);
    // No Kotlin policy in the runner's files.
    for (const [name, text] of [['CoreJob.kt', source('CoreJob.kt')], ['CoreWork.kt', coreWork], ['HostFiles.kt', nativeKt('pilot/core/HostFiles.kt')]]) {
        assert.doesNotMatch(code(text), /\.(sort\w*|sorted\w*|groupBy|reversed|distinct\w*|partition)\b/, `${name}: no Kotlin ordering`);
    }
}

// Pass W1 (widgets native): the engine's widget publisher on real core. The payload Kotlin receives is core's own Android
// publication for the store, the device's inputs and the device language; an unchanged payload is not sent again; nothing is
// sent before the boot's validated load; the Focus screen's filter reaches the widget with core's null sortOrder as RN's absent one.
{
    const harness = await build({
        stdin: { contents: `
            import { createWidgetPublisher } from './bundle/host-widgets.ts';
            import { buildAndroidWidgetPublication, getFocusWidgetFilter } from '@mindwtr/core';
            // The store from its own file: core is side-effect free and lazily initializes the modules its own dynamic imports
            // reach (store.ts among them), so an entry that reaches the store only through index.ts gets no init call from esbuild.
            import { useTaskStore } from '../../packages/core/src/store';
            export { buildAndroidWidgetPublication, getFocusWidgetFilter, useTaskStore, createWidgetPublisher };
        `, resolveDir: app, loader: 'ts' },
        bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    });
    const core = await import(`data:text/javascript;base64,${Buffer.from(harness.outputFiles[0].text).toString('base64')}`);
    const now = new Date().toISOString();
    const task = (id, title, extra = {}) => ({ id, title, status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now, ...extra });
    const data = {
        tasks: [task('a', 'Alpha', { contexts: ['@work'], dueDate: now }), task('b', 'Beta'), task('c', 'Gamma', { status: 'inbox' })],
        projects: [], sections: [], areas: [], settings: { language: 'system' },
    };
    core.useTaskStore.setState({ _allTasks: data.tasks, _allProjects: [], _allSections: [], _allAreas: [], settings: data.settings, lastDataChangeAt: 1 });
    const inputs = { systemColorScheme: 'dark', systemLocale: 'zh-CN', listSelections: ['inbox', 'filter:missing'] };
    let ready = false;
    const published = [];
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    const pendingTimers = [];
    let active = false;
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); pendingTimers.push(fn); return realSetTimeout(() => {}, 0); };
    const fireTimer = () => pendingTimers.pop()();
    try {
        const widgets = core.createWidgetPublisher({ ready: () => ready, inputs: () => inputs, publish: (text) => published.push(text), storedLanguage: () => null, active: () => active });
        assert.equal(widgets.publish(), false, 'nothing is published before the validated load');
        ready = true;
        assert.equal(widgets.publish(), true);
        // The device language (zh-CN) wins over 'system', as RN's resolveWidgetLanguage(saved, setting, getSystemDefaultLanguage()).
        const expected = (filter) => JSON.stringify(core.buildAndroidWidgetPublication(data, 'zh', { ...inputs, focusFilter: filter }));
        assert.equal(published[0], expected(core.getFocusWidgetFilter()), 'the payload is core\'s publication with the device\'s inputs');
        assert.equal(widgets.publish(), false, 'an unchanged payload is not sent again');
        assert.equal(published.length, 1);
        // Kotlin stores and draws off the engine thread; one that failed (or never finished) is sent again, the same payload too.
        inputs.stale = true;
        assert.equal(widgets.publish(), true, 'a publication that did not reach the widgets is sent again');
        assert.equal(published[1], published[0]);
        delete inputs.stale;
        assert.equal(widgets.publish(), false, 'once it reached them, it is not sent again');
        published.pop();
        widgets.focusFilter({ criteria: { contexts: ['@work'] }, sortBy: 'due', sortOrder: null });
        assert.deepEqual(timers, [1000], 'a new Focus filter republishes');
        assert.deepEqual(Object.entries(core.getFocusWidgetFilter()), [['criteria', { contexts: ['@work'] }], ['sortBy', 'due'], ['sortOrder', undefined]], 'core\'s null sortOrder is RN\'s absent one');
        widgets.focusFilter({ criteria: { contexts: ['@work'] }, sortBy: 'due', sortOrder: null });
        assert.equal(timers.length, 1, 'the same filter republishes nothing');
        assert.equal(widgets.publish(), true);
        assert.equal(published[1], expected({ criteria: { contexts: ['@work'] }, sortBy: 'due', sortOrder: undefined }));
        assert.notEqual(published[1], published[0], 'the widget shows the filtered Focus list');
        widgets.focusFilter(undefined);
        core.useTaskStore.setState({ lastDataChangeAt: 2 });
        assert.deepEqual(timers, [1000, 1000], 'a store change republishes after the delay');
        // RN's storage widget refresh (storage-adapter.ts, #766: a redraw costs seconds): while the app is in front, a store change
        // republishes at most once per five minutes; leaving the app publishes at once (Kotlin's background refresh). The Focus
        // screen's filter and the Focus start-date setting publish at once, as RN's direct calls do. Away from the front: one second.
        active = true;
        const sent = published.length;
        core.useTaskStore.setState({ _allTasks: [...data.tasks, task('d', 'Delta', { status: 'inbox' })], lastDataChangeAt: 3 });
        fireTimer();
        assert.equal(published.length, sent + 1, 'the waiting store change published');
        core.useTaskStore.setState({ _allTasks: [...data.tasks, task('d', 'Delta', { status: 'inbox' }), task('e', 'Epsilon', { status: 'inbox' })], lastDataChangeAt: 4 });
        assert(timers.at(-1) > 299_000 && timers.at(-1) <= 300_000, `in front, the next store change waits out five minutes (${timers.at(-1)} ms)`);
        widgets.focusFilter({ criteria: { contexts: ['@home'] }, sortBy: 'due', sortOrder: null });
        assert.equal(timers.at(-1), 1000, 'a new Focus filter publishes at once, the waiting change with it');
        fireTimer();
        assert.equal(published.length, sent + 2);
        core.useTaskStore.setState({ settings: { ...data.settings, gtd: { focusIncludeStartDates: false } }, lastDataChangeAt: 5 });
        assert.equal(timers.at(-1), 1000, 'the Focus start-date setting publishes at once');
        fireTimer();
        active = false;
        core.useTaskStore.setState({ _allTasks: data.tasks, lastDataChangeAt: 6 });
        assert.equal(timers.at(-1), 1000, 'away from the front, a store change publishes after one second');
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    // RN's widget components from RN's plugins (build-widgets.mjs): the four providers with their info XML, the dialog, the
    // configure, tap and peek activities, the list service, the capture receiver and the tile, under RN's names, in the app's one
    // process. Exported: exactly RN's, plus the debug build's two entries for the device check.
    const { buildManifest, buildTileSource, TILE_PACKAGE } = await import('./build-widgets.mjs');
    // The debug build's entries: one more manifest of each variant, so the debug build type's own manifest stays.
    const overlay = buildManifest('tech.dongdongbh.mindwtr.nativeclient.dev', 'Mindwtr Native Dev');
    assert.match(readFileSync(resolve(app, 'android/app/build.gradle.kts'), 'utf8'), /onVariants \{ variant ->\s+variant\.sources\.manifests\?\.addStaticManifestFile\(layout\.buildDirectory\.file\("generated\/widgets\/\$\{variant\.buildType\}\/AndroidManifest\.xml"\)/);
    const merged = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8') + overlay;
    const exportedNames = (text) => [...text.matchAll(/<(?:activity-alias|activity|receiver|service|provider)\s[^>]*?android:name="([^"]+)"[^>]*?android:exported="true"/g)].map((m) => m[1]).sort();
    assert.deepEqual(exportedNames(merged), ['${applicationId}.MainActivity', '.ReminderRescheduleReceiver', 'tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver',
        'tech.dongdongbh.mindwtr.androidwidget.CompactWidgetProvider', 'tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWidgetProvider',
        'tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider', 'tech.dongdongbh.mindwtr.androidwidget.WidgetConfigureActivity',
        'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver', 'tech.dongdongbh.mindwtr.nativeclient.dev.widget.TasksWidget',
        'tech.dongdongbh.mindwtr.quicksettings.CaptureTileService'], 'only RN\'s exported components');
    const debugManifest = readFileSync(resolve(app, 'android/app/src/debug/AndroidManifest.xml'), 'utf8');
    assert.deepEqual(exportedNames(debugManifest), ['${applicationId}.DebugQuickCapture', 'tech.dongdongbh.mindwtr.pilot.WidgetHostActivity'], 'the debug build adds only the check\'s two entries');
    assert(!existsSync(resolve(app, 'android/app/src/release')) && !existsSync(resolve(app, 'android/app/src/upgradetest')), 'no other build type adds an entry');
    assert.doesNotMatch(overlay, /android:process=/);
    for (const info of ['mindwtr_tasks_widget_info', 'mindwtr_compact_widget_info', 'mindwtr_quick_capture_widget_info', 'mindwtr_legacy_tasks_widget_info']) {
        assert.match(overlay, new RegExp(`android:resource="@xml/${info}"`), `${info} keeps RN's name`);
    }
    assert.equal(TILE_PACKAGE, 'tech.dongdongbh.mindwtr', 'the tile keeps RN\'s release class name');
    assert.equal(buildTileSource().replace('import tech.dongdongbh.mindwtr.pilot.R\n', 'import tech.dongdongbh.mindwtr.R\n'),
        (await import('node:module')).createRequire(import.meta.url)('../../mobile/plugins/android-quick-settings-tile.js').__testables.buildCaptureTileServiceSource(TILE_PACKAGE), 'the tile is RN\'s but for its R');
    // RN's check-off request codes and sweep action stay in RN's files, which compile as they are.
    const rnWidgetKt = (name) => readFileSync(resolve(app, '../mobile/modules/android-widget/android/src/main/java/tech/dongdongbh/mindwtr/androidwidget', name), 'utf8');
    assert.match(rnWidgetKt('WidgetRenderer.kt'), /REQUEST_CAPTURE = 4612[\s\S]*REQUEST_ROW = 4613/);
    assert.match(rnWidgetKt('CheckoffStore.kt'), /ACTION_SWEEP = "tech\.dongdongbh\.mindwtr\.androidwidget\.CHECKOFF_SWEEP"[\s\S]*REQUEST_SWEEP = 4614/);
    const widgetGradle = readFileSync(resolve(app, 'android/widget/build.gradle.kts'), 'utf8');
    assert.match(widgetGradle, /namespace = "tech\.dongdongbh\.mindwtr\.androidwidget"/, 'RN\'s R and namespace');
    assert.match(widgetGradle, /val rnExcluded = listOf\("AndroidWidgetModule", "CaptureSyncHeadlessService"\)/, 'only the Expo bridge and the headless task stay out');
    assert.equal(realpathSync(resolve(app, 'android/widget/src/main/res')), realpathSync(resolve(app, '../mobile/modules/android-widget/android/src/main/res')), 'the module\'s resources are RN\'s');
    // The widget module's hook is CoreWork's ingest job, set before any component runs.
    assert.match(readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MindwtrApplication.kt'), 'utf8'),
        /CaptureSyncHeadlessService\.install\(this\) \{ context -> CoreWork\.enqueue\(context, CoreJob\.INGEST\)\.result\.get\(DURABLE_WAIT_SECONDS, TimeUnit\.SECONDS\) \}/, 'the wake returns once WorkManager stored the job');
    assert.match(readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8'), /android:name="\.MindwtrApplication"/);
    // The Android bridge's two calls are guarded in CoreHost and published off the engine thread (HostWidgets).
    const coreHostKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/CoreHost.kt'), 'utf8');
    assert.match(coreHostKt, /bridge\.setProperty\("widgetInputs", guarded \{ _ -> widgets\.inputs\(\) \}\)/);
    assert.match(coreHostKt, /bridge\.setProperty\("widgetPublish", guarded \{ args -> widgets\.publish\(args\[0\] as String\); null \}\)/);
    assert.match(coreHostKt, /bridge\.setProperty\("widgetAppState", guarded \{ _ -> widgets\.appState\(\) \}\)/, 'the publisher reads whether the app is in front');
    // A boot publishes once it finished (its load, replay and drain), whatever the store's own changes did meanwhile: one that
    // came before the validated load was not sent. It waits with the boot's sync start for the first screen's content (startup
    // pass). Resume publishes through the same call, off the engine's callers.
    const ownerKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ProcessCoreHost.kt'), 'utf8');
    assert.match(ownerKt, /private fun refreshWidgets\(runtime: CoreHost\) = widgetThread\.execute \{\s+runCatching \{ runtime\.refreshWidgets\(\) \}\.onFailure \{ Log\.w\(CoreHost\.TAG, "Native Android widget refresh failed", it\) \}\s+\}/);
    // Coming to the front and leaving it both publish (RN's resume refresh and its flush on leaving). Coming to the front, it
    // waits for the screen's first content (startDeferredSync runs it) or the fallback, so a warm start draws first.
    assert.match(ownerKt, /if \(state == appState\) return\s+appState = state\s+(?:\/\/[^\n]*\s+)*boot\?\.takeIf \{ it\.isDone \}\?\.let \{ task -> runCatching \{ task\.get\(\) \}\.getOrNull\(\) \}\?\.let \{ runtime ->\s+if \(state == "active"\) \{\s+(?:\/\/[^\n]*\s+)*val generation = deferredWidgets\.hold\(runtime\)\s+widgetThread\.schedule\(\{ deferredWidgets\.takeIf\(generation\)\?\.let \{ publishHeldWidgets\(it, "resume-fallback"\) \} \},\s+WIDGET_FALLBACK_MS, TimeUnit\.MILLISECONDS\)\s+\} else \{\s+deferredWidgets\.clear\(\)\s+refreshWidgets\(runtime\)\s+\}\s+\}/, 'a resume\'s fallback publishes only its own hold (HeldPublicationTest)');
    // Kotlin says when a publication did not reach the widgets (its store or redraw failed), so the publisher sends it again.
    const hostWidgetsKt = readFileSync(resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostWidgets.kt'), 'utf8');
    assert.match(hostWidgetsKt, /\.put\("stale", stale\)/);
    assert.match(hostWidgetsKt, /check\(WidgetPayloadStore\.write\(app, payload\)\) \{ "[^"]+" \}/, 'a payload that did not reach the disk keeps the publication stale');
    assert.match(hostWidgetsKt, /\}\.onSuccess \{ stale = false \}\.onFailure \{\s+stale = true/);
    // The upgrade check allows the native app's one other file write only as RN's payload store: before, no file or exactly RN's
    // one `payload` key; after, exactly that key. Any other key added, changed type or removed fails.
    const { isRnPayloadPrefsWrite, widgetPrefs } = await import('./widget-payload.mjs');
    const prefs = (...entries) => widgetPrefs(`<map>${entries.join('')}</map>`);
    const payloadEntry = '<string name="payload">{}</string>';
    assert.equal(isRnPayloadPrefsWrite(prefs(), prefs(payloadEntry)), true, 'no file before, RN\'s payload after');
    assert.equal(isRnPayloadPrefsWrite(prefs(payloadEntry), prefs(payloadEntry)), true, 'RN\'s payload before and after');
    assert.equal(isRnPayloadPrefsWrite(prefs('<string name="other">x</string>'), prefs(payloadEntry)), false, 'another key deleted and the payload added fails');
    assert.equal(isRnPayloadPrefsWrite(prefs(payloadEntry), prefs(payloadEntry, '<int name="other" value="1" />')), false, 'another key added fails');
    assert.equal(isRnPayloadPrefsWrite(prefs(payloadEntry), prefs()), false, 'the payload removed fails');
    console.log('Widgets: core\'s Android publication from the engine with the device\'s inputs and language, sent once per change, after the validated load, with the Focus screen\'s filter');
}

const fakeCore = `
export { createDeviceCalendarSettingsMethods } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract-device-calendar-settings.ts'))};
export { createCalendarSubscriptionSettingsMethods } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract-calendar-subscription-settings.ts'))};
export { createCalendarSubscriptionAddMethods } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract-calendar-subscription-add.ts'))};
export { buildCalendarSubscriptionSettingsModel } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract-settings-calendar.ts'))};
export { REMINDER_STORE_RESCHEDULE_DELAY_MS, shouldRescheduleReminderAlarms } from ${JSON.stringify(resolve(app, '../../packages/core/src/mobile-reminder-alarms.ts'))};
export { nameNotifyListener } from ${JSON.stringify(resolve(app, '../../packages/core/src/store-notify-profiler.ts'))};
export { buildShortcutsSnapshot } from ${JSON.stringify(resolve(app, '../../packages/core/src/widget-payload.ts'))};
export { getNextFutureStartRevealAt } from ${JSON.stringify(resolve(app, '../../packages/core/src/task-utils.ts'))};
export { resolveEntityOpenTarget } from ${JSON.stringify(resolve(app, '../../packages/core/src/entry-points.ts'))};
export { compareAppVersions, fetchAppStoreInfo, UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_LAST_CHECK_KEY, UPDATE_BADGE_LATEST_KEY, shouldCheckForAppUpdate } from ${JSON.stringify(resolve(app, '../../packages/core/src/app-store-update.ts'))};
export { SYNC_BACKEND_KEY, CLOUD_PROVIDER_KEY } from ${JSON.stringify(resolve(app, '../../packages/core/src/sync-storage-keys.ts'))};
export { getBaseSyncUrl } from ${JSON.stringify(resolve(app, '../../packages/core/src/attachment-paths.ts'))};
import { NativeAttachmentCleanupUnconfirmedError as RealCleanupError } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-attachment-cleanup.ts'))};
export { RealCleanupError as NativeAttachmentCleanupUnconfirmedError };
import { mapSqliteTaskRow as hydrateTask285 } from ${JSON.stringify(resolve(app, '../../packages/core/src/sqlite-adapter.ts'))};
globalThis.hydrateTaskAttachments285 = (attachments) => hydrateTask285({ id: 'task285', attachments: JSON.stringify(attachments) }).attachments;
export { planAttachmentOpen, getAttachmentResolutionMessage } from ${JSON.stringify(resolve(app, '../../packages/core/src/attachment-editor-model.ts'))};
import { logInfo as realLogInfo, setLogger as setRealLogger } from ${JSON.stringify(resolve(app, '../../packages/core/src/logger.ts'))};
export { createDiagnosticsLog, diagnosticsEntryFromLogPayload, isDiagnosticsLoggingEnabled, buildDiagnosticsLogEntry } from ${JSON.stringify(resolve(app, '../../packages/core/src/diagnostics-log.ts'))};
export { createFeedbackDiagnosticsBuffer, buildFeedbackDiagnostics, buildFeedbackDiagnosticsSnapshot, FEEDBACK_DIAGNOSTICS_SOURCE_CHARS } from ${JSON.stringify(resolve(app, '../../packages/core/src/feedback-diagnostics.ts'))};
export { buildFeedbackSubmissionPayload, submitFeedbackSubmission, FEEDBACK_CATEGORIES } from ${JSON.stringify(resolve(app, '../../packages/core/src/feedback.ts'))};
export { sanitizeForLog, sanitizeLogContext } from ${JSON.stringify(resolve(app, '../../packages/core/src/log-sanitize.ts'))};
export { getBreadcrumbs } from ${JSON.stringify(resolve(app, '../../packages/core/src/log-breadcrumbs.ts'))};
export { validateNativeAttachmentDraftBeginV3, validateNativeAttachmentDraftLineageV3,
    validateNativeAttachmentDraftBeginV4, validateNativeAttachmentDraftLineageV4,
    validateNativeAttachmentDraftBeginV5, validateNativeAttachmentDraftLineageV5,
    prepareNativeAttachmentDraftAddV4, prepareNativeAttachmentDraftRemoveV4, completeNativeAttachmentDraftAddV4,
    prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    readNativeAttachmentDraftRemoveFrozen, prepareNativeAttachmentDraftAvailability } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-attachment-draft.ts'))};
export { prepareNativeAttachmentDraftDiscardCandidates, prepareNativeAttachmentDraftDiscardCandidatesV3, prepareNativeAttachmentDraftDiscardCandidatesV4, prepareNativeAttachmentDraftDiscardCandidatesV5 } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-attachment-draft-discard.ts'))};
export { prepareNativeAttachmentCleanupWitness, isNativeAttachmentCleanupWitnessEligible } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-attachment-cleanup.ts'))};
import { createOwnedEditorFileEditTaskDraftSaveMethods as createRealMixedSaveMethods } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract-owned-file-edit-save.ts'))};
import { createNativeHostContract as createRealCompleteContract } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-host-contract.ts'))};
import { NativeReceiptSqliteAdapter as RealCompleteAdapter } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-request-receipts.ts'))};
import { setStorageAdapter as setRealCompleteAdapter, useTaskStore as realCompleteStore,
    getPersistenceStatus as realCompletePersistence } from ${JSON.stringify(resolve(app, '../../packages/core/src/store.ts'))};
const realCompleteContract = createRealCompleteContract();
let realCompleteActivation;
async function completeFixtureContract() {
  if (!realCompleteActivation) realCompleteActivation = (async () => {
    if (!globalThis.completeSqliteClient) throw new Error('complete SQLite fixture unavailable');
    if (globalThis.completeSeed) await new RealCompleteAdapter(globalThis.completeSqliteClient).saveData(globalThis.completeSeed);
    const adapter = new RealCompleteAdapter(globalThis.completeSqliteClient, { rejectConcurrentWrites: true });
    if (globalThis.resumeFixture) {
      const read = adapter.getData.bind(adapter);
      adapter.getData = async (options) => { globalThis.resumeReads++; await globalThis.onResumeRead?.(); return read(options); };
      globalThis.actualResumeStore = realCompleteStore;
      globalThis.actualResumePersistence = realCompletePersistence;
    }
    setRealCompleteAdapter(adapter);
    const ready = await realCompleteContract.activate({ writeSafetyReady: true, recoveryLoad: true });
    if (!ready.ok) throw new Error('complete SQLite fixture activation failed: ' + JSON.stringify(ready));
  })();
  await realCompleteActivation; return realCompleteContract;
}
export { taskRevisionOf } from ${JSON.stringify(resolve(app, '../../packages/core/src/native-request-receipts.ts'))};
// File-only changed/noop fixtures have no ordinary patch fields. Refuse any
// field edit rather than manufacturing a second editor field policy here.
const realMixedSaveMethods = createRealMixedSaveMethods({ readiness: () => ({ ok: true, value: null }),
    save: async () => ({ ok: true, value: null }), validateField: () => false });
export { isAttachmentFileInUse } from ${JSON.stringify(resolve(app, '../../packages/core/src/attachment-draft-settlement.ts'))};
export { canSaveTaskListTag } from ${JSON.stringify(resolve(app, '../../packages/core/src/task-list-bulk-actions.ts'))};
export { formatListItemCount } from ${JSON.stringify(resolve(app, '../../packages/core/src/list-count.ts'))};
export { getBulkMoveStatusOptions } from ${JSON.stringify(resolve(app, '../../packages/core/src/task-list-bulk-actions.ts'))};
export { formatI18nTemplate } from ${JSON.stringify(resolve(app, '../../packages/core/src/i18n/index.ts'))};
// These service stand-ins test bridge dispatch/admission, not import or receipt policy.
// Actual shared policy and SQLite receipts have their own core and Swift/JSC suites.
export function inspectNativeBackupDocument(text, metadata, t, format = 'json') {
  globalThis.backupInputs.push(JSON.stringify(['inspect', text, metadata, format]));
  return { valid: true, title: t('settings.mergeBackup'),
    summary: t('settings.backupMobile.backupPreviewCounts', { taskCount: 2, projectCount: 1 }),
    confirmLabel: t('settings.mergeBackupAction'), cancelLabel: t('common.cancel'),
    errorTitle: t('settings.backupMobile.invalidBackup'), errorMessage: '' };
}
export async function prepareNativeBackupDocument(adapter, input) {
  globalThis.backupInputs.push(JSON.stringify(['prepare', adapter === globalThis.adapter, input]));
  if (globalThis.backupPrepareHold) await globalThis.backupPrepareHold;
  return globalThis.backupPrepared;
}
export async function commitNativeBackupDocument(adapter, reference, planJSON, snapshotName) {
  globalThis.backupInputs.push(JSON.stringify(['commit', adapter === globalThis.adapter, reference, planJSON, snapshotName]));
  return globalThis.backupReply;
}
export async function readNativeBackupDocumentOutcome(adapter, reference, planJSON, snapshotName) {
  globalThis.backupInputs.push(JSON.stringify(['outcome', adapter === globalThis.adapter, reference, planJSON, snapshotName]));
  return globalThis.backupOutcome;
}
export function buildNativeBackupDocumentResult(reply, t) {
  globalThis.backupInputs.push(JSON.stringify(['result', reply]));
  return { title: t('settings.mergeBackup'), message: t('settings.mergeBackupSummary', { addedCount: reply.added, updatedCount: reply.updated }),
    undoLabel: t('settings.undoImport'), doneLabel: t('common.done') };
}
export function buildNativeBackupSnapshotRestoreConfirmation(snapshotName, t) {
  globalThis.backupInputs.push(JSON.stringify(['restoreModel', snapshotName]));
  return { title: t('settings.undoImportConfirmTitle'), message: t('settings.undoImportConfirm', { snapshotName }),
    confirmLabel: t('markdown.referenceRestore'), cancelLabel: t('common.cancel') };
}
export function setLogger(logger) { globalThis.coreLogger = logger; setRealLogger(logger); }
export function consoleLogger() {}
export class SqliteAdapter {
  async ensureSchema() { globalThis.events.push('schema'); }
  // core's row-version read after activation: the ids and the mapped settings a full read would give (rowBaseline overrides;
  // rowBaselineNull is another connection's commit since the last full read).
  async readRowBaseline() {
    globalThis.events.push('baseline');
    if (globalThis.rowBaselineNull) return null;
    const data = globalThis.fakeData;
    return globalThis.rowBaseline || { ids: Object.fromEntries(['tasks', 'projects', 'sections', 'areas', 'people'].map((table) =>
      [table, data[table].map((row) => row.id)])), settings: data.settings };
  }
  async getData() {
    globalThis.events.push('load');
    globalThis.lastLoaded = globalThis.fakeDataSequence.shift() || globalThis.fakeData;
    return globalThis.lastLoaded;
  }
  async saveData(data) {
    globalThis.events.push('save');
    if (globalThis.saveError) throw new Error(globalThis.saveError);
    globalThis.fakeData = globalThis.afterSave || data;
  }
}
export function planLegacyJsonImport(state, current, sqliteHasData) {
  globalThis.events.push('plan');
  globalThis.planInputs.push(JSON.stringify([state, current.tasks.length, sqliteHasData]));
  return globalThis.plan;
}
export async function sqliteHasAnyData() { return globalThis.sqliteHasData; }
export function assertNativeLegacyBackupSafe() { globalThis.events.push('legacyCheck'); }
// Core compares every persisted field; the fake compares the whole snapshot.
export function legacyImportMismatch(merged, saved) { return JSON.stringify(merged) === JSON.stringify(saved) ? null : 'tasks'; }
export function splitSqlStatements(sql) { return [sql]; }
export class NativeReceiptSqliteAdapter extends SqliteAdapter {}
export async function loadNativeRequestReceipts(_client, options) { globalThis.receiptsLoadedAt = globalThis.events.length;
  globalThis.receiptScope = options?.durableCommands ?? null; return 0; }
export function setNativeReplayTokens(mode) { globalThis.replayTokens = mode; }
export async function pruneNativeRequestReceipts() { return 3; }
export function setStorageAdapter(adapter) { globalThis.adapter = adapter; }
export function getStorageAdapter() { return globalThis.adapter; }
export async function flushPendingSave() { globalThis.events.push('flush'); await globalThis.flushHold;
  if (globalThis.flushError) throw new Error(globalThis.flushError); }
export function getPersistenceStatus() { globalThis.onPersistenceStatus?.(); return globalThis.persistenceStatus ||
  { generation: 0, queued: false, inFlight: false, immediate: false, retrying: false, failed: false }; }
export function isSupportedLanguage(value) { return ['en', 'zh', 'fa', 'de'].includes(value); }
export function getGeneralSettingsDeviceWrites(edit) { return edit.type === 'language'
  ? [{ key: 'mindwtr-language', value: edit.value }] : [
  { key: '@mindwtr_theme', value: edit.value },
  { key: '@mindwtr_theme_style', value: edit.value === 'material3-light' || edit.value === 'material3-dark' ? 'material3' : 'default' },
]; }
// The queue drain's and the context notification's names (pending-captures.ts, mobile-reminder-alarms.ts, sandbox.ts).
export const PENDING_CAPTURES_DIRECTORY = 'pending-captures';
export const PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY = 'mindwtr:pending-captures:last-applied:v1';
export const REMINDER_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
export const REMINDER_ALARM_MAP_STORAGE_KEY = 'mindwtr:local:alarms:v1';
export const NATIVE_REMINDER_STATE_STORAGE_KEY = 'mindwtr:native:reminders:v1';
export const NATIVE_HOST_CONTRACT_VERSION = 1;
export function buildImmediateNotificationDetails(title, message, data) { return { title, message, channel: 'mindwtr_reminders_v2', data: { kind: 'pomodoro', ...data } }; }
export function isSandboxMode() { return globalThis.sandbox === true; }
export const isEntityOpenUrl = () => false;
export const parseEntityOpenUrl = () => null;
export function isWorkspaceTransitionActive() { return globalThis.workspaceTransition === true; }
// The debug net check's WebDAV calls: bundled, never run here.
export const [cloudHeadJson, webdavDeleteFile, webdavGetFile, webdavGetJson, webdavGetSyncDocument, webdavHeadFile, webdavMakeDirectory, webdavPutFile, webdavPutJson] = Array(9).fill(async () => null);
export function createNativeHostContract(bindings = {}) {
  globalThis.contractBindings = bindings;
  return {
    async activate() {
      globalThis.events.push('activate');
      await globalThis.adapter.getData();
      globalThis.activationCount++;
      globalThis.saveCount++;
      return { ok: true, value: null };
    },
    getInboxWindow() {
      globalThis.queryCount++;
      return { ok: true, value: { version: 1, revision: 'r', total: 0, rows: [] } };
    },
    getFocus(input) {
      globalThis.focusInputs.push(JSON.stringify(input));
      return { ok: true, value: { version: 1, revision: 'f', sections: [] } };
    },
    getFocusSectionWindow(input) {
      globalThis.focusInputs.push(JSON.stringify(input));
      return globalThis.focusWindowResult;
    },
    // An AI request that waits until its caller's signal aborts it (review C1 5: MindwtrHost.abort).
    requestTaskEditorClarify(input, options) {
      globalThis.aiInputs.push(JSON.stringify(input));
      return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason)); });
    },
    getTaskEditorModel(input) {
      globalThis.editorInputs.push(JSON.stringify(input));
      return { ok: true, value: { version: 1, id: input.id } };
    },
    async checkOwnedTaskEditorResume(input) { globalThis.resumeInputs.push(['owned', input]);
        return (await completeFixtureContract()).checkOwnedTaskEditorResume(input); },
    async checkTaskEditorResume(input) { globalThis.resumeInputs.push(['ordinary', input]);
        return (await completeFixtureContract()).checkTaskEditorResume(input); },
    getTaskView(input) {
      globalThis.editorInputs.push(JSON.stringify(['view', input]));
      if (globalThis.localTaskViewFailure) return globalThis.localTaskViewFailure;
      return { ok: true, value: { version: 1, id: input.id, readOnly: globalThis.localTaskReadOnly === true, rows: [], checklistBase: [{ id: 'c', title: 'Milk', isCompleted: true }] } };
    },
    async prepareOwnedEditorFileEditTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['prepare', input]); return globalThis.fileEditSaveReply; },
    validatePreparedOwnedEditorFileEditTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['validate', input]);
        return globalThis.realMixedSaveValidation ? realMixedSaveMethods.validatePreparedOwnedEditorFileEditTaskDraftSave(input) : globalThis.fileEditSaveReply; },
    async commitPreparedOwnedEditorFileEditTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['commit', input]); return globalThis.fileEditSaveReply; },
    async prepareOwnedEditorCompleteTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['completePrepare', input]);
        return (await completeFixtureContract()).prepareOwnedEditorCompleteTaskDraftSave(input); },
    validatePreparedOwnedEditorCompleteTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['completeValidate', input]);
        return realCompleteContract.validatePreparedOwnedEditorCompleteTaskDraftSave(input); },
    async commitPreparedOwnedEditorCompleteTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['completeCommit', input]);
        return (await completeFixtureContract()).commitPreparedOwnedEditorCompleteTaskDraftSave(input); },
    async prepareOwnedEditorCompleteTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['completeUndoPrepare', input]);
        return (await completeFixtureContract()).prepareOwnedEditorCompleteTaskCancellationUndo(input); },
    validatePreparedOwnedEditorCompleteTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['completeUndoValidate', input]);
        return realCompleteContract.validatePreparedOwnedEditorCompleteTaskCancellationUndo(input); },
    async commitPreparedOwnedEditorCompleteTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['completeUndoCommit', input]);
        return (await completeFixtureContract()).commitPreparedOwnedEditorCompleteTaskCancellationUndo(input); },
    async prepareTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['oldUndoPrepare', input]);
        return realCompleteContract.prepareTaskCancellationUndo(input); },
    validatePreparedTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['oldUndoValidate', input]);
        return realCompleteContract.validatePreparedTaskCancellationUndo(input); },
    async commitPreparedTaskCancellationUndo(input) { globalThis.fileEditSaveInputs.push(['oldUndoCommit', input]);
        return realCompleteContract.commitPreparedTaskCancellationUndo(input); },
    async prepareOwnedEditorFileAddTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['legacyPrepare', input]); return globalThis.fileEditSaveReply; },
    validatePreparedOwnedEditorFileAddTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['legacyValidate', input]); return globalThis.fileEditSaveReply; },
    async commitPreparedOwnedEditorFileAddTaskDraftSave(input) { globalThis.fileEditSaveInputs.push(['legacyCommit', input]); return globalThis.fileEditSaveReply; },
    async addAttachmentFile(input) { globalThis.attachmentInputs.push(['draftAddFile', input]); return globalThis.attachmentReply; },
    async removeAttachment(input) { globalThis.attachmentInputs.push(['draftRemove', input]); return globalThis.attachmentReply; },
    getProjectAttachmentEditOptions(input) {
      globalThis.projectOptionsReads = (globalThis.projectOptionsReads ?? 0) + 1;
      const project = globalThis.ownerProjects.find((item) => item.id === input.projectId);
      return project && !project.deletedAt && !project.purgedAt
        ? { ok: true, value: { revision: 'project-revision', project, canEdit: project.status !== 'archived' } }
        : { ok: false, error: { code: 'STALE_REVISION', message: 'Project unavailable' } };
    },
    async runSyncEncryptionAction(input) {
      globalThis.encryptionInputs ??= [];
      globalThis.encryptionInputs.push(input);
      if (bindings.syncSettings?.encryption?.mode !== 'saved-webdav-or-local'
          || bindings.syncSettings.encryption.unlockOnly !== undefined) throw new Error('Missing selected WebDAV or local encryption capability');
      return globalThis.encryptionReply ?? { ok: true, value: { toasts: [], passphrase: null } };
    },
    getSyncSettings() { return { ok: true, value: { backend: { options: ['off', 'webdav', 'selfhosted', 'dropbox', 'cloudkit', 'file'].map(option => ({ option })) } } }; },
    async openSyncSettings(input) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['openSyncSettings', input]); return this.getSyncSettings(); },
    async selectSyncBackend(input) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['selectSyncBackend', input]); return globalThis.foregroundReply ?? { ok: true, value: { toasts: [] } }; },
    async saveSyncBackend(input) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['saveSyncBackend', input]); return globalThis.foregroundReply ?? { ok: true, value: { toasts: [] } }; },
    async syncNow(input) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['syncNow', input]); return globalThis.foregroundReply ?? { ok: true, value: { toasts: [] } }; },
    async testSyncConnection(input) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['testSyncConnection', input]); return globalThis.foregroundReply ?? { ok: true, value: { toasts: [] } }; },
    async downloadAttachment(input) {
      globalThis.attachmentInputs.push(['downloadAttachment', input]);
      globalThis.downloadHosts.push(bindings.attachments);
      await globalThis.downloadHold;
      if (globalThis.downloadFatal) throw new RealCleanupError();
      if (globalThis.downloadError) throw new Error(globalThis.downloadError);
      globalThis.afterDownload?.();
      return globalThis.attachmentReply;
    },
    async downloadRelocatedProjectAttachment(input, currentTargetURI) {
      globalThis.attachmentInputs.push(['downloadRelocatedProjectAttachment', input, currentTargetURI]);
      globalThis.downloadHosts.push(bindings.attachments);
      await globalThis.downloadHold;
      if (globalThis.downloadFatal) throw new RealCleanupError();
      if (globalThis.downloadError) throw new Error(globalThis.downloadError);
      globalThis.afterDownload?.();
      return globalThis.attachmentReply;
    },
    async openAttachment(input) { globalThis.attachmentInputs.push(['openAttachment', input]); return globalThis.attachmentReply; },
    async settleTaskDraftAttachments(input) { globalThis.attachmentInputs.push(['settleTaskDraftAttachments', input]); return globalThis.attachmentReply; },
    editTaskChecklist(input) {
      globalThis.editorInputs.push(JSON.stringify(['checklist', input]));
      return { ok: true, value: { draft: input.draft, checklist: input.checklist, changed: false, focusId: null, field: { items: [] } } };
    },
    async resetTaskChecklist(input) {
      globalThis.updateInputs.push(JSON.stringify(['reset', input]));
      return { ok: true, value: { id: input.id, checklist: [] } };
    },
    getTaskEditorSuggestions(input) {
      globalThis.editorInputs.push(JSON.stringify(['suggest', input]));
      return { ok: true, value: { draftValue: '@home', matches: [], quick: [] } };
    },
    editTaskDraft(input) {
      globalThis.editorInputs.push(JSON.stringify(['edit', input]));
      return { ok: true, value: { version: 1, id: input.id, draft: input.draft } };
    },
    async saveTaskDraft(input) {
      globalThis.updateInputs.push(JSON.stringify(['draft', input]));
      return globalThis.saveDraftResult;
    },
    async updateTask(input) {
      globalThis.updateInputs.push(JSON.stringify(input));
      return globalThis.updateResult;
    },
    async setLanguage(input) {
      globalThis.languageInputs.push(JSON.stringify(input));
      globalThis.afterLanguage?.();
      return { ok: true, value: { language: input.storedLanguage ?? 'en' } };
    },
    getStrings(input) {
        globalThis.languageInputs.push(JSON.stringify(input));
        return { ok: true, value: { language: 'zh', strings: Object.fromEntries(input.keys.map((key) =>
          [key, key === 'tab.inbox' ? '收集箱' : globalThis.backupStrings[key] ?? key])), missing: [] } };
    },
    getDataSettings() {
        globalThis.backupReadinessChecks++;
        globalThis.onReadiness?.();
        return globalThis.backupReadinessResult;
    },
    async prepareReferenceTasksAddTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceTagPrepare', input]));
      return { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } };
    },
    validatePreparedReferenceTasksAddTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceTagValidate', input]));
      return { ok: true, value: input.prepared.result };
    },
    async commitPreparedReferenceTasksAddTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceTagCommit', input]));
      return { ok: true, value: input.prepared.result };
    },
    async referenceTasksAddTagOutcome(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceTagOutcome', input]));
      return { ok: true, value: input.prepared.result };
    },
    async prepareReferenceTasksRemoveTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceRemoveTagPrepare', input]));
      return { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } };
    },
    validatePreparedReferenceTasksRemoveTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceRemoveTagValidate', input]));
      return { ok: true, value: input.prepared.result };
    },
    async commitPreparedReferenceTasksRemoveTag(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceRemoveTagCommit', input]));
      return { ok: true, value: input.prepared.result };
    },
    async referenceTasksRemoveTagOutcome(input) {
      globalThis.menuInputs.push(JSON.stringify(['referenceRemoveTagOutcome', input]));
      return { ok: true, value: input.prepared.result };
    },
    getProjects() {
      globalThis.projectInputs.push('projects');
      return { ok: true, value: { version: 1, revision: 'p', active: [], deferred: [], archived: [] } };
    },
    getProjectDetail(input) {
      globalThis.projectInputs.push(JSON.stringify(input));
      return globalThis.projectDetailResult;
    },
    async submitQuickCapture(input) { globalThis.createCount++; globalThis.captureInputs.push(JSON.stringify(['submit', input])); return { ok: true, value: { kind: 'saved', taskId: 'id', next: 'close', reset: null } }; },
    openQuickCapture() { globalThis.captureInputs.push('open'); return { ok: true, value: { version: 1, options: {} } }; },
    getQuickCaptureView(input) { globalThis.captureInputs.push(JSON.stringify(['view', input])); return { ok: true, value: { version: 1, options: input.options } }; },
    editQuickCapture(input) { globalThis.captureInputs.push(JSON.stringify(['edit', input])); return { ok: true, value: { view: { options: input.options }, notice: null } }; },
    async createQuickCaptureSnapshot() { globalThis.captureInputs.push('snapshot'); return globalThis.snapshotResult; },
    async submitQuickCaptureLines(input) { globalThis.captureInputs.push(JSON.stringify(['lines', input])); return { ok: true, value: { kind: 'saved', taskIds: input.captureIds } }; },
    async submitQuickCapturePickerQuery(input) { globalThis.captureInputs.push(JSON.stringify(['picker', input])); return { ok: true, value: { options: input.options, created: true } }; },
    openCaptureModal(input) { globalThis.captureInputs.push(JSON.stringify(['modalOpen', input])); return { ok: true, value: { draft: { text: '' }, view: { version: 1 } } }; },
    getCaptureModalView(input) { globalThis.captureInputs.push(JSON.stringify(['modalView', input])); return { ok: true, value: { version: 1 } }; },
    editCaptureModal(input) { globalThis.captureInputs.push(JSON.stringify(['modalEdit', input])); return { ok: true, value: { draft: input.draft, view: { version: 1 } } }; },
    discardCaptureModal(input) { globalThis.captureInputs.push(JSON.stringify(['modalDiscard', input])); return { ok: true, value: { close: { returnTo: null, returnToPreviousApp: false } } }; },
    async submitCaptureModal(input) { globalThis.captureInputs.push(JSON.stringify(['modalSubmit', input])); return { ok: true, value: { kind: 'saved', taskId: input.captureId, projectId: null, next: 'close', close: { returnTo: null, returnToPreviousApp: false } } }; },
    async submitCaptureModalLines(input) { globalThis.captureInputs.push(JSON.stringify(['modalLines', input])); return { ok: true, value: { kind: 'saved', taskIds: input.captureIds, close: { returnTo: null, returnToPreviousApp: true } } }; },
    async setTaskFocus(input) { globalThis.newInputs.push(JSON.stringify(['taskFocus', input])); return globalThis.taskFocusResult; },
    async setProjectFocus(input) { globalThis.newInputs.push(JSON.stringify(['projectFocus', input])); return { ok: true, value: { blocked: '' } }; },
    async createProject(input) { globalThis.newInputs.push(JSON.stringify(['createProject', input])); return { ok: true, value: { id: 'p' } }; },
    getAreaFilter() { globalThis.newInputs.push('areaFilter'); return { ok: true, value: { revision: 'a', label: 'All', summary: 'All areas', options: [] } }; },
    async setAreaFilter(input) { globalThis.newInputs.push(JSON.stringify(['setAreaFilter', input])); return { ok: true, value: input }; },
    async completeTask() { globalThis.completeCount++; return { ok: true, value: { id: 'id' } }; },
    async searchTasks(input) { globalThis.newInputs.push(JSON.stringify(['search', input])); return { ok: true, value: { version: 1, query: input.query.trim() } }; },
    async saveSearch(input) { globalThis.newInputs.push(JSON.stringify(['saveSearch', input])); return { ok: true, value: { id: 's', existing: false } }; },
    startInboxProcessing(input) { globalThis.newInputs.push(JSON.stringify(['inboxStart', input])); return { ok: true, value: { sessionId: 'x', view: { step: 'actionable' } } }; },
    getInboxProcessingStep(input) { globalThis.newInputs.push(JSON.stringify(['inboxStep', input])); return { ok: true, value: { step: 'actionable' } }; },
    async commitInboxProcessingStep(input) { globalThis.newInputs.push(JSON.stringify(['inboxCommit', input])); return globalThis.inboxCommitResult; },
    async skipInboxProcessingTask(input) { globalThis.newInputs.push(JSON.stringify(['inboxSkip', input])); return { ok: true, value: { view: null, notice: null, toast: null } }; },
    endInboxProcessing(input) { globalThis.newInputs.push(JSON.stringify(['inboxEnd', input])); return { ok: true, value: null }; },
    getMoreMenu() { globalThis.menuInputs.push('more'); return { ok: true, value: { version: 1, revision: 'm', primary: [] } }; },
    getWaitingView(input) { globalThis.menuInputs.push(JSON.stringify(['waiting', input])); return { ok: true, value: { version: 1, revision: 'w', total: 0, rows: [] } }; },
    getSomedayView(input) { globalThis.menuInputs.push(JSON.stringify(['someday', input])); return globalThis.menuReadResult; },
    getMenuViewCollection(input) { globalThis.menuInputs.push(JSON.stringify(['collection', input])); return { ok: true, value: { items: [] } }; },
    getArchiveView(input) { globalThis.menuInputs.push(JSON.stringify(['archive', input])); return { ok: true, value: { version: 1, items: [] } }; },
    async moveSomedayTasksToSection(input) { globalThis.menuInputs.push(JSON.stringify(['somedayMove', input])); return globalThis.menuCommandResult; },
    async addSomedaySectionTask(input) { globalThis.menuInputs.push(JSON.stringify(['somedayTask', input])); return { ok: true, value: { id: input.captureId, toast: 'Task created' } }; },
    async runArchiveAction(input) { globalThis.menuInputs.push(JSON.stringify(['archiveAction', input])); return { ok: true, value: { changed: true, toast: null } }; },
    getContextsView(input) { globalThis.menuInputs.push(JSON.stringify(['contexts', input])); return { ok: true, value: { version: 1, revision: 'c', total: 0, rows: [] } }; },
    getTrashView(input) { globalThis.menuInputs.push(JSON.stringify(['trash', input])); return { ok: true, value: { version: 1, revision: 't', total: 0, items: [] } }; },
    getReviewOverview(input) { globalThis.menuInputs.push(JSON.stringify(['review', input])); return { ok: true, value: { version: 1, revision: 'o', total: 0, items: [] } }; },
    getWeeklyReview(input) { globalThis.menuInputs.push(JSON.stringify(['weekly', input])); return { ok: true, value: { version: 1, revision: 'w', total: 0, items: [] } }; },
    getWeeklyReviewList(input) { globalThis.menuInputs.push(JSON.stringify(['weeklyList', input])); return { ok: true, value: { version: 1, revision: 'w', total: 0, items: [] } }; },
    getDailyReview(input) { globalThis.menuInputs.push(JSON.stringify(['daily', input])); return { ok: true, value: { version: 1, revision: 'd', total: 0, items: [] } }; },
    async runContextsAction(input) { globalThis.menuInputs.push(JSON.stringify(['contextsAction', input])); return { ok: true, value: { changed: true, toast: null } }; },
    async runTrashAction(input) { globalThis.menuInputs.push(JSON.stringify(['trashAction', input])); return { ok: true, value: { changed: true, toast: null } }; },
    async ingestPendingCaptures(input) {
      const names = await input.queue.list();
      const texts = [];
      for (const name of names ?? []) texts.push(await input.queue.read(name));
      const record = await input.lastApplied.read();
      if (names?.length) await input.lastApplied.write('{"t":{"tapMs":1,"id":"c","at":2}}');
      for (const name of names ?? []) await input.queue.delete(name);
      globalThis.ingestInputs.push(JSON.stringify([input.requestId, names, texts, record]));
      return { ok: true, value: { ingested: names?.length ?? 0 } };
    },
    runContextAutomation(input) {
      globalThis.ingestInputs.push(JSON.stringify(['context', input]));
      return { ok: true, value: { notification: input.action === 'activate' ? { title: '@home next action', message: 'Call', data: { kind: 'context-automation', context: '@home' } } : null } };
    },
    async runReviewAction(input) {
      globalThis.menuInputs.push(JSON.stringify(['reviewAction', input]));
      return input.action.type === 'markReviewedTasks' ? { ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } } : { ok: true, value: { changed: true, toast: null, createdId: null } };
    },
  };
}
export const DEFAULT_GLOBAL_SEARCH_FILTERS = { scope: 'all' };
export const STATUS_COLORS_BY_THEME = {
  light: { done: { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' } }, dark: { done: { bg: '#4ADE8026', text: '#4ADE80', border: '#4ADE80' } },
  nord: { done: { bg: '#A3BE8C26', text: '#A3BE8C', border: '#A3BE8C' } },
};
export const TASK_PRIORITY_COLORS = { urgent: '#dc2626', low: '#3b82f6' };
export function themeDescriptor(theme) {
  return new Map([['nord', { scheme: 'dark', statusPreset: 'nord' }],
    ['material3-light', { scheme: 'light', statusPreset: null }]]).get(theme);
}
export function resolveThemeStatusPreset(theme) { return themeDescriptor(theme)?.statusPreset ?? null; }
export const useTaskStore = { getState: () => {
  globalThis.onStateRead?.();
  return {
  settings: globalThis.settings,
  _allTasks: globalThis.lastLoaded ? globalThis.lastLoaded.tasks : globalThis.emptyOwnerTasks,
  _tasksById: globalThis.ownerTaskMap,
  _allProjects: globalThis.ownerProjects, _allSections: [], _allAreas: [], _allPeople: [],
  persistenceFailure: globalThis.persistenceFailure, isLoading: globalThis.storeLoading, editLockCount: globalThis.storeEditLocks,
}; } };
export function logInfo(message, meta) {
  if (globalThis.__mindwtrHostPlatform === 'ios') return realLogInfo(message, meta);
  throw new Error('diagnostic sink failed');
}
export function logWarn() { throw new Error('diagnostic sink failed'); }
// The durable iOS draft owner is exercised by the actual-core Swift host tests.
// Legacy owner fixtures remain unbound; Task257 below exercises the real pure V3 helpers.
export function validateNativeAttachmentDraftBegin() { throw new Error('attachment draft owner unbound'); }
export function validateNativeAttachmentDraftLineage() { throw new Error('attachment draft owner unbound'); }
export function prepareNativeAttachmentDraftAdd() { throw new Error('attachment draft owner unbound'); }
export function validateNativeAttachmentDraftBeginV2() { throw new Error('attachment draft owner unbound'); }
export function validateNativeAttachmentDraftLineageV2() { throw new Error('attachment draft owner unbound'); }
export function prepareNativeAttachmentDraftAddV2() { throw new Error('attachment draft owner unbound'); }
export function completeNativeAttachmentDraftAdd() { throw new Error('attachment draft owner unbound'); }
// Only the explicit iOS local-capability fixture may construct these. Backends
// and sync triggers retain the throwing stand-ins below.
export function createMobileAttachmentFiles(host) {
  if (!globalThis.localAttachmentTest) throw new Error('local attachments unbound');
  globalThis.localFilePorts = host;
  return { persistAttachmentLocally: async (attachment) => attachment, deleteManagedAttachmentFile: async () => false };
}
export function createMobileAttachmentInstaller() {
  if (!globalThis.localAttachmentTest) throw new Error('local attachments unbound');
  return { installAttachmentFileGeneration: async () => { throw new Error('no remote installer call'); } };
}
export function createMobileAttachmentCommon(host) {
  if (!globalThis.localAttachmentTest) throw new Error('local attachments unbound');
  if (host.preparePlaintextDownload) return { prepareAttachmentDownloadBytes: async () => { throw new Error('Unexpected source creation in Off entry fixture'); } };
  return {};
}
export function setSha256HexProvider() {
  if (!globalThis.localAttachmentTest) throw new Error('local attachments unbound');
  globalThis.localShaInstallCount++;
}
`;
// host-sync.ts's and host-reminders.ts's core imports: bound only on a host with the key-value or the alarm bridges, which the
// stand-in bridge below lacks, so they are bundled and never run here. Each one the fake does not define throws if anything calls it.
// host-attachments.ts's too: host-sync.ts binds them on the same host only. host-widgets.ts's are bound only on a host with RN's
// widget module (Android), which the stand-in bridge lacks too.
const hostSyncTs = readFileSync(resolve(app, 'bundle/host-sync.ts'), 'utf8') + readFileSync(resolve(app, 'bundle/host-attachments.ts'), 'utf8')
    + readFileSync(resolve(app, 'bundle/host-reminders.ts'), 'utf8') + readFileSync(resolve(app, 'bundle/host-widgets.ts'), 'utf8');
const syncOnly = [...new Set([...hostSyncTs.matchAll(/^import \{([\s\S]*?)\} from '@mindwtr\/core';/gm)].flatMap((m) => [...m[1].matchAll(/^\s+(\w+),$/gm)].map((n) => n[1])))]
    .filter((name) => !new RegExp(`export (?:async )?(?:function|const|class) ${name}\\b|export \\{[^}]*\\b${name}\\b`).test(fakeCore));
assert(syncOnly.includes('createMobileSyncService') && syncOnly.includes('createMobileSyncTriggers'), 'host-sync.ts\'s core imports parsed');
// S4b final pass: core's partly-encrypted rule runs only when the host gives the sync service the location probe; without it a
// device with encryption off would upload plain attachments beside ciphertext. The card's "Check this location again" needs recheck.
// The cycle names its own folder (an activation's candidate is not the stored one), passed through as it is.
assert(/probeLocationCiphertext: \(target\) => transitions\.probeSyncLocationCiphertext\(target\),/.test(hostSyncTs), 'the native sync service asks whether the location holds ciphertext');
assert(/recheck: async \(\) => \{\s*const outcome = await transitions\.recheckPartlyEncryptedLocation\(\);/.test(hostSyncTs), 'the native encryption card rechecks a partly encrypted location');
const fakeCoreWithSync = `${fakeCore}\n${syncOnly.map((name) => `export const ${name} = () => { throw new Error('${name}: sync is not bound in the gates'); };`).join('\n')}\n`;
const built = await build({
    entryPoints: [resolve(app, 'bundle/host-entry.ts')], bundle: true, write: false, format: 'iife',
    plugins: [{ name: 'fake-core', setup(plugin) {
        plugin.onResolve({ filter: /^@mindwtr\/core$/ }, () => ({ path: 'core', namespace: 'test' }));
        plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: fakeCoreWithSync, loader: 'js', resolveDir: app }));
    } }],
});
const makeState = (taskCount, fakeDataSequence = [], hostPlatform = undefined, configure = () => {}, source = built.outputFiles[0].text) => {
    const state = {
        fakeData: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
        fakeDataSequence, activationCount: 0, saveCount: 0, queryCount: 0,
        __mindwtrHostPlatform: hostPlatform,
        events: [], planInputs: [], plan: null, sqliteHasData: true, saveError: null, afterSave: null, lastLoaded: null, commitResult: null,
        createCount: 0, completeCount: 0, persistenceFailure: null, captureInputs: [],
        snapshotResult: { ok: true, value: { fileName: 'data.2026-09-24T10-00-00.000.snapshot.json', contents: '{}' } }, editorInputs: [], updateInputs: [], focusInputs: [],
        // host-polyfills.js gives QuickJS these; the harness runs host-entry alone.
        AbortController, setTimeout, clearTimeout, TextEncoder, URL,
        languageInputs: [], projectInputs: [], settings: undefined, persistenceStatus: null, aiInputs: [],
        settingsReadFailure: false, afterLanguage: null, newInputs: [], menuInputs: [],
        fileCalls: [], ingestInputs: [], queueFiles: null, kv: {}, deleteResult: null, sandbox: false,
        workspaceTransition: false, backupInputs: [], backupReadinessChecks: 0,
        backupReadinessResult: { ok: true, value: { version: 1 } }, backupPrepareHold: null,
        backupPrepared: { planJSON: '{"frozen":true}', recoveryJSON: '{"before":true}' },
        backupReply: { version: 1, operation: 'merge', snapshotName: 'data.2026-10-04T12-00-00.000.snapshot.json', added: 2, updated: 1 },
        backupOutcome: null,
        backupStrings: { 'settings.mergeBackup': '合并备份',
          'settings.backupMobile.backupPreviewCounts': '{{taskCount}} tasks / {{projectCount}} projects',
          'settings.mergeBackupSummary': '{{addedCount}} added / {{updatedCount}} updated',
          'settings.undoImportConfirm': 'Restore {{snapshotName}}; later edits are rolled back' },
        menuReadResult: { ok: false, error: { code: 'STALE_REVISION', message: 'Someday changed; restart paging from offset zero' } },
        menuCommandResult: { ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } },
        taskFocusResult: { ok: true, value: { blocked: 'Max 5 focus items.', blockedTitle: 'Focus' } },
        projectDetailResult: { ok: false, error: { code: 'STALE_REVISION', message: 'Project changed; restart paging from offset zero' } },
        focusWindowResult: { ok: false, error: { code: 'STALE_REVISION', message: 'Focus changed; restart paging' } },
        updateResult: { ok: true, value: { id: 't', changed: true } },
        saveDraftResult: { ok: true, value: { id: 't', draft: { title: 'b' } } },
        inboxCommitResult: { ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } },
        logText: null, logOps: [], logFailure: null,
        localAttachmentTest: false, localShaInstallCount: 0, attachmentInputs: [],
        fileEditSaveInputs: [], fileEditSaveReply: { ok: true, value: null }, resumeInputs: [], resumeReads: 0,
        emptyOwnerTasks: [], ownerProjects: [], ownerTaskMap: new Map(), storeLoading: false, storeEditLocks: 0,
        attachmentReply: { ok: true, value: { kind: 'saved', ids: [], attachments: [] } },
        __mindwtrNative: {
            sqlAll(sql) {
                if (sql === 'SELECT data FROM settings WHERE id = 1') {
                    if (state.settingsReadFailure) return '!MindwtrNativeError:settings storage unavailable';
                    return state.fakeData.settings ? JSON.stringify([{ data: JSON.stringify(state.fakeData.settings) }]) : '[]';
                }
                if (sql === 'SELECT COUNT(*) AS n FROM settings WHERE id = 1')
                    return JSON.stringify([{ n: state.fakeData.settings ? 1 : 0 }]);
                // 'auto': the tasks count matches the load, as a real database would.
                if (sql.includes('COUNT(*)') && sql.includes('tasks')) {
                    return JSON.stringify([{ n: taskCount === 'auto' ? state.lastLoaded.tasks.length : taskCount }]);
                }
                if (sql.includes('COUNT(*)') && sql.includes('saved_filters')) return JSON.stringify([{ n: state.filterCount ?? 0 }]);
                if (sql.includes('COUNT(*)')) return '[{"n":0}]';
                return '[]';
            },
            sqlRun() {}, sqlExec() {},
            rnStateCommit(change) { state.events.push(`commit:${change}`); return state.commitResult; },
            // Kotlin's DiagnosticsLogFile on one in-memory file (logText null: no file).
            logFile(operation, text) {
                state.logOps.push(operation);
                if (state.logFailure) return `!MindwtrNativeError:${state.logFailure}`;
                switch (operation) {
                    case 'path': return state.logUnavailable ? '' : 'files/logs/mindwtr.log';
                    case 'ensure': state.logText ??= ''; return 'files/logs/mindwtr.log';
                    case 'exists': return state.logText === null ? '' : '1';
                    case 'isAbsent': return state.logAbsentError ? '!MindwtrNativeError:absence unknown' : state.logText === null ? '1' : '';
                    case 'read': return state.logText;
                    case 'size': return String(Buffer.byteLength(state.logText ?? ''));
                    case 'append': state.logText += text; return '';
                    case 'write': state.logText = text; return '';
                    case 'delete': { if (state.logDeleteRefused) return ''; const had = state.logText !== null; state.logText = null; return had ? '1' : ''; }
                    default: throw new Error(`unknown log operation ${operation}`);
                }
            },
            // Kotlin's HostFiles and RnKeyValue: a marked string is a Kotlin failure.
            fileList(path) { state.fileCalls.push(`list ${path}`); return state.queueFiles ? JSON.stringify(Object.keys(state.queueFiles)) : 'null'; },
            fileRead(path) { state.fileCalls.push(`read ${path}`); return state.queueFiles[path.split('/').pop()]; },
            fileDelete(path) { state.fileCalls.push(`delete ${path}`); return state.deleteResult; },
            kvGet(key) { state.fileCalls.push(`kvGet ${key}`); return JSON.stringify([state.kv[key] ?? null]); },
            kvSet(key, value) { state.fileCalls.push(`kvSet ${key} ${value}`); state.kv[key] = value; return null; },
        },
    };
    configure(state);
    vm.runInNewContext(source, state);
    assert.equal(state.contractBindings.reminderPlatform, hostPlatform === 'ios' ? 'ios' : 'android');
    return state;
};
const poll = async (state, id) => {
    await new Promise((resolveTick) => setImmediate(resolveTick));
    return JSON.parse(state.MindwtrHost.poll(id));
};
// Task362: real pure route/projection and the production private-entry Off/admission path.
// Native363 separately proves actual HTTP/receipt/intent/recovery with the real core bundle.
{
    const AT = '2026-10-07T00:00:00.000Z', taskID = 'task362';
    const selected = { id: 'baseline362', kind: 'file', title: 'Fixture.txt', uri: '', cloudKey: 'attachments/baseline362.txt',
        localStatus: 'missing', createdAt: AT, updatedAt: AT };
    const request = { version: 1, requestId: '00000000-0000-4000-8000-000000000362',
        sessionID: '00000000-0000-4000-8000-000000000363', generation: 0, attachmentId: selected.id,
        identity: '' };
    const beforePayloadJSON = JSON.stringify({ version: 2, taskID, attachmentsOwned: true,
        attachmentsBase: [selected], attachments: [selected], opaque: 'Retain 文' });
    // Use the actual shared identity grammar, not an independently guessed tuple.
    const identityBuild = await build({ stdin: { contents: `export { getAttachmentDownloadIdentity } from './mobile-attachment-availability';`,
        resolveDir: resolve(app, '../../packages/core/src'), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'identity362' });
    const identityState = {}; vm.runInNewContext(identityBuild.outputFiles[0].text, identityState);
    request.identity = identityState.identity362.getAttachmentDownloadIdentity(selected);
    const base = { version: 1, taskID, beforePayloadJSON, requestJSON: JSON.stringify(request) };
    const route = { ...base, webdavURL: 'https://synthetic.invalid/dav/data.json', managedDirectoryURI: 'file:///library/documents/attachments/' };
    const configure = (state) => {
        state.localAttachmentTest = true; state.localShaInstallCount = 0; state.selectedIoCalls = 0;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) {
            state.__mindwtrNative[name] = () => { state.selectedIoCalls++; throw new Error('Unexpected selected IO'); };
        }
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => { state.selectedIoCalls++; throw new Error('Unexpected selected file IO'); };
        state.__mindwtrInstallerCall = async () => { throw new Error('No selected installer'); };
        state.__mindwtrSyncSecrets = { getSecret: async () => { state.selectedIoCalls++; throw new Error('No Off secret read'); } };
    };
    const state = makeState(0, [], 'ios', configure);
    const preflight = () => poll(state, state.MindwtrHost.attachmentDraftAvailabilityPreflight(JSON.stringify(route)));
    assert.match((await preflight()).error, /^NOT_READY:/);
    assert.equal((await poll(state, state.MindwtrHost.boot())).ok, true);
    assert.deepEqual((await preflight()).value, { version: 1, requestId: request.requestId, attachmentJSON: JSON.stringify(selected),
        initialURL: 'https://synthetic.invalid/dav/attachments/baseline362.txt', targetURI: 'file:///library/documents/attachments/baseline362.txt' });
    const rawConfigJSON = JSON.stringify({ backend: 'off', url: null, username: null, allowInsecureHttp: null, encryptionStateJSON: null });
    const run = (input = { ...base, rawConfigJSON }, callback = () => { throw new Error('No Off source callback'); }) =>
        poll(state, state.MindwtrHost.iosTaskDraftPrepareAvailability(JSON.stringify(input), callback));
    const logBefore = state.logText, shaBefore = state.localShaInstallCount;
    assert.deepEqual(await run(), { ok: true, value: { version: 1, requestId: request.requestId, status: 'unavailable' } });
    assert.match((await run({ ...base, rawConfigJSON, extra: true })).error, /^INVALID_INPUT:/);
    assert.deepEqual((await run()).value, { version: 1, requestId: request.requestId, status: 'unavailable' }, 'A refused invocation releases its private slot');
    assert.match((await run(undefined, null)).error, /^NOT_READY:/);
    for (const field of ['sandbox', 'workspaceTransition']) {
        state[field] = true; assert.match((await run()).error, /^NOT_READY:/); assert.match((await preflight()).error, /^NOT_READY:/); state[field] = false;
    }
    assert.equal(state.selectedIoCalls, 0); assert.equal(state.localShaInstallCount, shaBefore); assert.equal(state.logText, logBefore);
    const resolved = { ...selected, uri: route.managedDirectoryURI + 'baseline362.txt', localStatus: 'available', fileHash: 'a'.repeat(64) };
    const proof = await poll(state, state.MindwtrHost.attachmentDraftPrepareAvailability(JSON.stringify({ version: 1, taskID,
        requestId: request.requestId, attachmentId: selected.id, identity: request.identity, beforePayloadJSON,
        status: 'available', resolvedAttachmentJSON: JSON.stringify(resolved) })));
    assert.equal(proof.ok, true); assert.equal(proof.value.kind, 'prepared-file-availability');
    assert.deepEqual(JSON.parse(proof.value.afterPayloadJSON).attachments, [resolved]);
    assert.equal(JSON.parse(proof.value.afterPayloadJSON).opaque, 'Retain 文');
    const android = makeState(0, [], 'android');
    assert.match((await poll(android, android.MindwtrHost.attachmentDraftAvailabilityPreflight(JSON.stringify(route)))).error, /^NOT_READY:/);
    assert.match((await poll(android, android.MindwtrHost.iosTaskDraftPrepareAvailability(JSON.stringify({ ...base, rawConfigJSON }), () => ''))).error, /^NOT_READY:/);
}
// HTTP transport alone enables no KV/sync/AI binding. Its private fixed
// receipt uses the existing forced Diagnostics writer, without request input.
{
    const configureHTTP = (state) => {
        state.httpCalls = 0;
        state.__mindwtrNative.netFetch = () => { state.httpCalls++; throw new Error('Unexpected startup network'); };
        state.__mindwtrNative.netAbort = () => {};
        state.__mindwtrNative.ioNext = () => '';
        state.__mindwtrNative.ioBody = () => '';
    };
    const local = makeState(0, [], 'ios', configureHTTP);
    assert.deepEqual(Object.keys(local.contractBindings).filter((name) => local.contractBindings[name] !== undefined), ['reminderPlatform']);
    assert.equal(typeof local.__mindwtrNative.kvMultiGet, 'undefined');
    local.MindwtrHost.nativeHTTPDelivered();
    assert.equal(local.logText, null, 'No preboot transport receipt');
    assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
    assert.equal(local.httpCalls, 0, 'Installing transport starts no request');
    local.settings = { diagnostics: { loggingEnabled: false } };
    local.MindwtrHost.nativeHTTPDelivered();
    await poll(local, local.MindwtrHost.logShare()); // Existing append/share barrier.
    const lines = local.logText.split('\n').filter((line) => line.includes('v1.3.5/ios-http-transport'));
    assert.equal(lines.length, 1, 'Forced marker survives disabled logging');
    assert.deepEqual(JSON.parse(lines[0]).context, {
        releaseCheck: 'v1.3.5/ios-http-transport', operation: 'http-transport', outcome: 'delivered',
    });
    const before = local.logText;
    for (const field of ['sandbox', 'workspaceTransition']) {
        local[field] = true; local.MindwtrHost.nativeHTTPDelivered(); local[field] = false;
    }
    await new Promise((tick) => setImmediate(tick));
    assert.equal(local.logText, before, 'Unsettled workspace emits no receipt');
    for (const platform of ['android', undefined]) {
        const other = makeState(0, [], platform, configureHTTP);
        assert.equal((await poll(other, other.MindwtrHost.boot())).ok, true);
        const prior = other.logText;
        other.MindwtrHost.nativeHTTPDelivered(); await new Promise((tick) => setImmediate(tick));
        assert.equal(other.logText, prior, 'Invalid platform emits no transport marker');
        assert.equal(other.httpCalls, 0);
    }
}
// Secret and crypto ports alone leave KV/sync/AI absent. Their fixed receipts
// use the existing forced Diagnostics writer without executing a primitive.
for (const [bridge, receipt, operation] of [
    ['secretCall', 'nativeSecretDelivered', 'secure-storage'],
    ['cryptoCall', 'nativeCryptoDelivered', 'sync-crypto'],
]) {
    const configurePort = (state) => {
        state.primitiveCalls = 0;
        state.__mindwtrNative[bridge] = () => { state.primitiveCalls++; throw new Error('Unexpected startup native primitive'); };
        state.__mindwtrNative.ioNext = () => '';
        state.__mindwtrNative.ioBody = () => '';
    };
    const local = makeState(0, [], 'ios', configurePort);
    assert.deepEqual(Object.keys(local.contractBindings).filter((name) => local.contractBindings[name] !== undefined), ['reminderPlatform']);
    assert.equal(typeof local.__mindwtrNative.kvMultiGet, 'undefined');
    local.MindwtrHost[receipt]();
    assert.equal(local.logText, null, 'No preboot native primitive receipt');
    assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
    assert.equal(local.primitiveCalls, 0, 'Installing the native bridge performs no startup operation');
    local.settings = { diagnostics: { loggingEnabled: false } };
    local.MindwtrHost[receipt]();
    await poll(local, local.MindwtrHost.logShare());
    const lines = local.logText.split('\n').filter((line) => line.includes(`v1.3.5/ios-${operation}`));
    assert.equal(lines.length, 1, 'Forced native primitive marker survives disabled logging');
    assert.deepEqual(JSON.parse(lines[0]).context, {
        releaseCheck: `v1.3.5/ios-${operation}`, operation, outcome: 'delivered',
    });
    const before = local.logText;
    for (const field of ['sandbox', 'workspaceTransition']) {
        local[field] = true; local.MindwtrHost[receipt](); local[field] = false;
    }
    await new Promise((tick) => setImmediate(tick));
    assert.equal(local.logText, before, 'Unsettled workspace emits no native primitive receipt');
    for (const platform of ['android', undefined]) {
        const other = makeState(0, [], platform, configurePort);
        assert.equal((await poll(other, other.MindwtrHost.boot())).ok, true);
        const prior = other.logText;
        other.MindwtrHost[receipt](); await new Promise((tick) => setImmediate(tick));
        assert.equal(other.logText, prior, 'Invalid platform emits no native primitive marker');
        assert.equal(other.primitiveCalls, 0);
    }
}
// Explicit iOS KV presence remains a transport capability, not Sync activation.
// Its fixed successful-delivery sink is forced, but never records settings data.
{
    const receipts = [
        ['nativeDeviceStorageDelivered', 'ios-device-storage', 'device-storage'],
        ['nativeLegacySecretRetirementDelivered', 'ios-legacy-secret-retirement', 'legacy-secret-retirement'],
    ];
    const names = ['kvGet', 'kvSet', 'kvRemove', 'kvMultiGet', 'kvMultiSet', 'kvMultiRemove'];
    const configureKV = (state) => {
        state.kvBridgeCalls = 0;
        for (const name of names) state.__mindwtrNative[name] = () => {
            state.kvBridgeCalls++; throw new Error('Unexpected startup device storage');
        };
    };
    const local = makeState(0, [], 'ios', configureKV);
    assert.deepEqual(Object.keys(local.contractBindings).filter((name) => local.contractBindings[name] !== undefined), ['reminderPlatform'], 'KV does not enable iOS Sync or AI');
    for (const name of names) assert.equal(typeof local.__mindwtrNative[name], 'function');
    for (const [method] of receipts) local.MindwtrHost[method]();
    assert.equal(local.logText, null, 'No preboot device storage receipt');
    assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
    assert.equal(local.kvBridgeCalls, 0, 'Explicit storage bridge performs no startup request');
    local.settings = { diagnostics: { loggingEnabled: false } };
    for (const [method] of receipts) local.MindwtrHost[method]();
    await poll(local, local.MindwtrHost.logShare());
    for (const [, slug, operation] of receipts) {
        const lines = local.logText.split('\n').filter((line) => line.includes(`v1.3.5/${slug}`));
        assert.equal(lines.length, 1, 'Forced fixed storage marker survives disabled logging');
        assert.deepEqual(JSON.parse(lines[0]).context, {
            releaseCheck: `v1.3.5/${slug}`, operation, outcome: 'delivered',
        });
    }
    const before = local.logText;
    for (const field of ['sandbox', 'workspaceTransition']) {
        local[field] = true; for (const [method] of receipts) local.MindwtrHost[method](); local[field] = false;
    }
    await new Promise((tick) => setImmediate(tick));
    assert.equal(local.logText, before, 'Unsettled workspace emits no device storage receipt');
    local.logFailure = 'synthetic diagnostic failure';
    assert.doesNotThrow(() => local.MindwtrHost.nativeLegacySecretRetirementDelivered());
    await new Promise((tick) => setImmediate(tick));
    assert.equal(local.logText, before, 'Logging failure does not emit or throw a retirement receipt');
    local.logFailure = null;
    for (const platform of ['android', undefined]) {
        const other = makeState(0, [], platform);
        assert.equal((await poll(other, other.MindwtrHost.boot())).ok, true);
        const prior = other.logText;
        for (const [method] of receipts) other.MindwtrHost[method](); await new Promise((tick) => setImmediate(tick));
        assert.equal(other.logText, prior, 'Invalid platform emits no device storage receipt');
        assert.equal(typeof other.__mindwtrNative.kvMultiGet, 'undefined');
    }
}
// Task346 and selected encryption exercise the production entry with narrow factory/core stand-ins.
// Actual contract state admission and availability/installer/crypto/JSC acceptance have separate suites.
{
    const syncFixture = `
export function createHostSyncCrypto() { return {}; }
export function isNativeIosSelfHostedProvider(value) { return !value?.trim() || value.trim() === 'selfhosted'; }
export function createNativeSync() {
  globalThis.syncFactoryCalls++;
  return { attachmentsHost: globalThis.remoteAttachmentHost, settingsHost: { encryption: {} },
    async assertSelfHostedSyncAdmission() { globalThis.admissionChecks = (globalThis.admissionChecks ?? 0) + 1;
      if (globalThis.incompleteTransition) throw new Error('Sync encryption transition is incomplete'); },
    async performStoredAutomaticSync(reason) { globalThis.foregroundInputs ??= []; globalThis.foregroundInputs.push(['stored', reason]);
      return globalThis.storedReply ?? { success: true, skipped: false }; } };
}
`;
    const downloadBuilt = await build({
        entryPoints: [resolve(app, 'bundle/host-entry.ts')], bundle: true, write: false, format: 'iife',
        plugins: [{ name: 'project-download-entry', setup(plugin) {
            plugin.onResolve({ filter: /^\.\/host-sync$/ }, () => ({ path: 'sync', namespace: 'download-test' }));
            plugin.onLoad({ filter: /.*/, namespace: 'download-test' }, () => ({ contents: syncFixture, loader: 'js' }));
            plugin.onResolve({ filter: /^@mindwtr\/core$/ }, () => ({ path: 'core', namespace: 'test' }));
            plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: fakeCoreWithSync, loader: 'js', resolveDir: app }));
        } }],
    });
    const input = { projectId: 'project346', attachmentId: 'attachment346', revision: 'project-revision' };
    const attachment = { id: input.attachmentId, kind: 'file', title: 'Synthetic346', uri: 'file:///library/documents/attachments/attachment346.pdf' };
    const create = (platform = 'ios') => makeState(0, [], platform, (state) => {
        state.localAttachmentTest = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null; state.__mindwtrInstallerCall = async () => null;
        state.syncFactoryCalls = 0; state.secretReads = 0; state.storedReads = 0; state.downloadHosts = [];
        state.remoteAttachmentHost = { selected: 'remote-346' };
        state.ownerProjects = []; // Install the selected row only after the empty VM boot verifies.
        state.storedBackend = 'webdav';
        // On non-iOS, avoid eager normal Sync so the explicit entry itself is tested.
        if (platform === 'ios') state.__mindwtrNative.kvMultiGet = () => { throw new Error('Unexpected multi-read'); };
        state.__mindwtrNative.kvGet = (key) => { state.storedReads++; return JSON.stringify([
            key === '@mindwtr_cloud_provider' ? state.storedProvider ?? null : state.storedBackend ?? null]); };
        state.__mindwtrSyncSecrets = { getSecret: () => { state.secretReads++; throw new Error('Unexpected secret read'); } };
        state.attachmentReply = { ok: true, value: { status: 'available', message: null, update: null } };
        state.settings = { diagnostics: { loggingEnabled: false } };
    }, downloadBuilt.outputFiles[0].text);
    const boot = async (state) => {
        const answer = await poll(state, state.MindwtrHost.boot());
        if (answer.ok) state.ownerProjects = [{ id: input.projectId, status: 'active', attachments: [{ ...attachment }] }];
        return answer;
    };
    const command = (state, value = input) => poll(state,
        state.MindwtrHost.iosForegroundSync('projectAttachmentDownload', JSON.stringify(value), () => ''));
    const markerLines = (state) => (state.logText ?? '').split('\n').filter((line) => line.includes('v1.3.5/ios-project-file-download'));
    // Selected encryption admission runs before any configured service or secret read.
    const encrypted = create();
    const unlock = { revision: 'saved-location', action: { type: 'open', flow: 'unlock' } };
    const unlockCommand = (value) => poll(encrypted,
        encrypted.MindwtrHost.iosForegroundSync('runSyncEncryptionAction', JSON.stringify(value), () => ''));
    assert.equal((await boot(encrypted)).ok, true);
    const invalidEncryptionInputs = [null, [], {}, { ...unlock, revision: '' }, { ...unlock, revision: 'r'.repeat(101) },
        { ...unlock, requestId: '11111111-1111-1111-1111-111111111111' }, { ...unlock, extra: true },
        { ...unlock, action: { type: 'open', flow: 'unknown' } },
        ...['generate', 'reveal', 'recheck'].map((type) => ({ ...unlock, action: { type } })),
        { ...unlock, action: { type: 'typed', field: 'unknown', value: 'synthetic' } },
        ...['current', 'next', 'confirm'].map((field) => ({ ...unlock, action: { type: 'typed', field, value: 'x'.repeat(1001) } })),
        { ...unlock, action: { type: 'typed', field: 'confirm', value: '🧠'.repeat(501) } },
        ...['unlock', 'enable', 'change', 'disable', 'abandon'].map((flow) => ({ ...unlock, action: { type: 'submit', flow } })),
        { ...unlock, action: { type: 'decline' }, requestId: 'invalid' },
        { ...unlock, action: { type: 'recheck' }, requestId: 'invalid' },
        { ...unlock, action: { type: 'open', flow: 'enable', extra: true } },
        { ...unlock, action: { type: 'typed', field: 'next', value: 'synthetic', extra: true } }];
    for (const value of invalidEncryptionInputs) {
        assert.match((await unlockCommand(value)).error, /^INVALID_INPUT:/);
    }
    assert.equal(encrypted.storedReads, 0);
    assert.equal(encrypted.syncFactoryCalls, 0);
    assert.equal(encrypted.secretReads, 0);
    const unsupportedEncryptionBackends = ['dropbox', 'file', 'cloud', 'cloudkit', 'unsupported'];
    for (const backend of unsupportedEncryptionBackends) {
        encrypted.storedBackend = backend;
        assert.deepEqual((await unlockCommand(unlock)).value, { ok: false, error: { code: 'ACTION_FAILED',
            message: 'This sync provider is not available in native iOS yet; the stored configuration is unchanged' } });
        assert.equal(encrypted.storedBackend, backend);
    }
    assert.equal(encrypted.syncFactoryCalls, 0);
    assert.equal(encrypted.secretReads, 0);
    assert.equal(encrypted.encryptionInputs?.length ?? 0, 0, 'Unsupported providers never reach the selected contract');
    // This entry routes Off/missing envelopes to core; it does not decide local state, revision or transition admission.
    const localEncryptionActions = [{ type: 'open', flow: 'enable' },
        ...['next', 'confirm'].map((field) => ({ type: 'typed', field, value: 'synthetic-local-388' })),
        { type: 'submit', flow: 'enable' }, { type: 'open', flow: 'disable' }, { type: 'submit', flow: 'disable' }];
    const locallyRoutedBackends = [undefined, '', 'off', ' off '];
    for (const backend of locallyRoutedBackends) {
        const localEncryption = create(); assert.equal((await boot(localEncryption)).ok, true);
        localEncryption.storedBackend = backend;
        const localCommand = (value) => poll(localEncryption,
            localEncryption.MindwtrHost.iosForegroundSync('runSyncEncryptionAction', JSON.stringify(value), () => ''));
        for (const action of localEncryptionActions) {
            const value = { revision: unlock.revision, action,
                ...(action.type === 'submit' ? { requestId: '11111111-1111-1111-1111-111111111111' } : {}) };
            assert.deepEqual((await localCommand(value)).value, { ok: true, value: { toasts: [], passphrase: null } });
            assert.deepEqual(JSON.parse(JSON.stringify(localEncryption.encryptionInputs.at(-1))), value);
            assert.equal(localEncryption.storedBackend, backend, 'Routing never activates or rewrites a backend');
        }
        assert.equal(localEncryption.syncFactoryCalls, 1, 'Local routing retains one foreground service');
        assert.equal(localEncryption.contractBindings.syncSettings.encryption.mode, 'saved-webdav-or-local');
        localEncryption.encryptionReply = { ok: false, error: { code: 'ACTION_FAILED', message: 'Synthetic selected-state refusal' } };
        assert.deepEqual(await localCommand({ ...unlock, action: { type: 'open', flow: 'disable' } }),
            { ok: true, value: localEncryption.encryptionReply }, 'Core admission refusals survive local routing');
        assert.equal(localEncryption.syncFactoryCalls, 1); assert.equal(localEncryption.secretReads, 0);
        assert(!(localEncryption.logText ?? '').includes('synthetic-local-388'), 'Local field text never enters entry diagnostics');
    }
    encrypted.storedBackend = 'webdav';
    const selectedEncryptionActions = [...['unlock', 'enable', 'change', 'disable', 'abandon'].map((flow) => ({ type: 'open', flow })),
        ...['current', 'next', 'confirm'].map((field) => ({ type: 'typed', field, value: 'synthetic' })),
        ...['unlock', 'enable', 'change', 'disable', 'abandon'].map((flow) => ({ type: 'submit', flow })),
        { type: 'decline' }, { type: 'cancel' }, { type: 'retry' }, { type: 'recheck' }];
    for (const action of selectedEncryptionActions) {
        const value = { revision: unlock.revision, action,
            ...(['submit', 'decline', 'recheck'].includes(action.type) ? { requestId: '11111111-1111-1111-1111-111111111111' } : {}) };
        assert.equal((await unlockCommand(value)).value.ok, true);
        assert.deepEqual(JSON.parse(JSON.stringify(encrypted.encryptionInputs.at(-1))), value);
    }
    assert.equal(encrypted.syncFactoryCalls, 1, 'Selected encryption uses the retained foreground service');
    assert.equal(encrypted.secretReads, 0, 'Entry fixture reads no credentials');
    assert(!(encrypted.logText ?? '').includes('synthetic'), 'Passphrase never enters entry diagnostics');
    console.log(`Selected encryption: ${invalidEncryptionInputs.length} invalid envelopes refused before storage; ${unsupportedEncryptionBackends.length} providers refused before factory; ${selectedEncryptionActions.length} WebDAV and ${localEncryptionActions.length * locallyRoutedBackends.length} local envelopes routed with exact mode and UUID ownership; ${locallyRoutedBackends.length} core refusals preserved (NodeVM)`);
    const foreground = create();
    assert.equal((await boot(foreground)).ok, true);
    const foregroundCommand = (name, value, currentTargetURI) => poll(foreground,
        foreground.MindwtrHost.iosForegroundSync(name, JSON.stringify(value), () => '', currentTargetURI));
    const selfHostedFields = { url: 'https://synthetic398.invalid/v1/data', token: null, allowInsecureHttp: false };
    const webdavFields = { url: 'https://synthetic398.invalid/data.json', username: 'synthetic', password: null, allowInsecureHttp: false };
    const request = { requestId: '11111111-1111-1111-1111-111111111111', revision: 'config-398' };
    const malformedForms = [{}, { webdav: webdavFields, selfHosted: selfHostedFields }, { selfHosted: null },
        { selfHosted: [] }, { selfHosted: { ...selfHostedFields, password: 'synthetic' } },
        { webdav: { ...webdavFields, token: null } }, { selfHosted: { ...selfHostedFields, token: 1 } }];
    for (const name of ['saveSyncBackend', 'syncNow', 'testSyncConnection']) for (const fields of malformedForms) {
        assert.match((await foregroundCommand(name, { ...request, ...fields })).error, /^INVALID_INPUT:/);
    }
    assert.equal(foreground.storedReads, 0, 'Malformed/mixed forms never read configuration');
    assert.equal(foreground.syncFactoryCalls, 0, 'Malformed/mixed forms never construct a service');
    assert.equal(foreground.secretReads, 0);
    foreground.storedBackend = 'cloud';
    for (const provider of ['dropbox', 'cloudkit', 'file', 'unknown']) {
        foreground.storedProvider = provider;
        const refusal = await foregroundCommand('openSyncSettings', {});
        assert.equal(refusal.value.error.code, 'ACTION_FAILED');
        assert.equal(foreground.storedProvider, provider, 'Unsupported provider authority is never rewritten');
    }
    assert.equal(foreground.syncFactoryCalls, 0);
    for (const provider of [undefined, '', 'selfhosted', ' selfhosted ']) {
        foreground.storedProvider = provider;
        const model = await foregroundCommand('openSyncSettings', {});
        assert.deepEqual(JSON.parse(JSON.stringify(model.value.value.backend.options.map(({ option }) => option))), ['off', 'webdav', 'selfhosted']);
        for (const name of ['saveSyncBackend', 'syncNow', 'testSyncConnection']) {
            const value = { ...request, selfHosted: selfHostedFields };
            assert.equal((await foregroundCommand(name, value)).value.ok, true);
            assert.deepEqual(JSON.parse(JSON.stringify(foreground.foregroundInputs.at(-1))), [name, value]);
        }
        for (const [name, reason] of [['syncStored', 'startup'], ['syncResume', 'resume']]) {
            assert.deepEqual((await foregroundCommand(name, {})).value.value, { success: true, skipped: false });
            assert.deepEqual(JSON.parse(JSON.stringify(foreground.foregroundInputs.at(-1))), ['stored', reason]);
        }
    }
    assert.equal(foreground.syncFactoryCalls, 1, 'All self-hosted foreground commands retain one owned factory');
    assert.equal(foreground.secretReads, 0, 'Entry never reads credentials itself');
    assert(!(foreground.logText ?? '').includes('synthetic398'), 'Owned command marker contains no endpoint or token');
    for (const [name, value] of [['selectSyncBackend', { requestId: request.requestId, option: 'selfhosted' }],
        ...['saveSyncBackend', 'syncNow', 'testSyncConnection'].map(name => [name, { ...request, selfHosted: selfHostedFields }]),
        ['syncStored', {}], ['syncResume', {}]]) {
        foreground.incompleteTransition = true;
        const prior = foreground.foregroundInputs.length;
        const priorDownloads = foreground.attachmentInputs.length;
        const priorLog = foreground.logText;
        const refusal = await foregroundCommand(name, value);
        assert.deepEqual(refusal.value, { ok: false, error: { code: 'ACTION_FAILED', message: 'Sync encryption transition is incomplete' } });
        assert.equal(foreground.foregroundInputs.length, prior, 'Incomplete transition refuses before shared settings dispatch');
        assert.equal(foreground.attachmentInputs.length, priorDownloads, 'Incomplete transition refuses before availability bytes');
        assert.equal(foreground.logText, priorLog, 'Refused admission emits no settled-command marker');
    }
    foreground.incompleteTransition = false;
    assert.equal((await foregroundCommand('selectSyncBackend', { requestId: request.requestId, option: 'selfhosted' })).value.ok, true);
    // Ordinary cloud Project requests refuse independently at entry, even when
    // configuration is valid. They never reach options, factory or availability.
    const ordinaryCloudProject = create(); assert.equal((await boot(ordinaryCloudProject)).ok, true);
    ordinaryCloudProject.storedBackend = 'cloud';
    const ordinaryLogs = ordinaryCloudProject.logText;
    for (const provider of [undefined, '', 'selfhosted', ' selfhosted ']) {
        ordinaryCloudProject.storedProvider = provider;
        assert.deepEqual((await command(ordinaryCloudProject)).value, { ok: false, error: { code: 'ACTION_FAILED',
            message: 'This sync provider is not available in native iOS yet; the stored configuration is unchanged' } });
    }
    assert.equal(ordinaryCloudProject.syncFactoryCalls, 0); assert.equal(ordinaryCloudProject.secretReads, 0);
    assert.equal(ordinaryCloudProject.projectOptionsReads ?? 0, 0); assert.equal(ordinaryCloudProject.attachmentInputs.length, 0);
    assert.equal(ordinaryCloudProject.logText, ordinaryLogs, 'Gated ordinary cloud Project emits no completion marker');
    const downloadsBefore = foreground.attachmentInputs.length;
    const localForegroundHost = foreground.contractBindings.attachments;
    const mappedTarget = attachment.uri;
    assert.equal((await foregroundCommand('projectAttachmentDownload', input, mappedTarget)).value.ok, true);
    assert.equal(foreground.attachmentInputs.length, downloadsBefore + 1, 'Saved selfhosted relocated Project routes through selected availability');
    assert.deepEqual(JSON.parse(JSON.stringify(foreground.attachmentInputs.at(-1))), ['downloadRelocatedProjectAttachment', {
        ...input, managedDirectoryURI: mappedTarget.slice(0, mappedTarget.lastIndexOf('/') + 1),
    }, mappedTarget]);
    assert.notEqual(foreground.downloadHosts.at(-1), foreground.remoteAttachmentHost, 'Relocated selfhosted availability uses its read-only scoped host');
    assert.equal(foreground.contractBindings.attachments, localForegroundHost, 'Relocated Project scope restores the local host');
    foreground.incompleteTransition = true;
    const blockedDownloads = foreground.attachmentInputs.length;
    const blockedLogs = foreground.logText;
    assert.deepEqual((await foregroundCommand('projectAttachmentDownload', input, mappedTarget)).value,
        { ok: false, error: { code: 'ACTION_FAILED', message: 'Sync encryption transition is incomplete' } });
    assert.equal(foreground.attachmentInputs.length, blockedDownloads, 'Incomplete transition refuses before relocated Project availability');
    assert.equal(foreground.logText, blockedLogs, 'Refused relocated admission emits no completion marker');
    foreground.incompleteTransition = false;
    foreground.foregroundReply = { ok: false, error: { code: 'STALE_REVISION', message: 'Synthetic shared stale refusal' } };
    assert.deepEqual((await foregroundCommand('saveSyncBackend', { ...request, selfHosted: selfHostedFields })).value,
        foreground.foregroundReply, 'Shared revision/admission refusal survives routing');
    console.log(`Self-hosted entry: ${malformedForms.length * 3} invalid/mixed forms before storage; 4 unsupported providers before factory; 4 legacy/provider forms routed; 7 incomplete-transition commands before dispatch; 4 ordinary cloud Project forms before factory; scoped read-only relocated Project routing and restoration (NodeVM)`);
    const malformed = create();
    assert.match((await command(malformed)).error, /^NOT_READY:/);
    const bootMalformed = await boot(malformed);
    assert.equal(bootMalformed.ok, true, JSON.stringify(bootMalformed));
    for (const value of [null, [], {}, { ...input, projectId: '' }, { ...input, attachmentId: 1 }, { ...input, revision: null },
        { ...input, projectId: 'x'.repeat(501) }, { ...input, attachmentId: 'x'.repeat(501) }, { ...input, revision: 'x'.repeat(201) },
        { ...input, uri: 'file:///foreign' }, { ...input, remoteKey: 'synthetic' }, { ...input, password: 'synthetic' },
        { ...input, extra: 'x'.repeat(128 * 1024) }]) assert.match((await command(malformed, value)).error, /^INVALID_INPUT:/);
    assert.equal(malformed.storedReads, 0); assert.equal(malformed.syncFactoryCalls, 0); assert.equal(malformed.secretReads, 0);
    for (const flag of ['failed', 'queued', 'inFlight', 'immediate', 'retrying']) {
        malformed.persistenceStatus = { [flag]: true }; assert.match((await command(malformed)).error, /^NOT_READY:/);
    }
    malformed.persistenceStatus = null;
    for (const field of ['sandbox', 'workspaceTransition']) {
        malformed[field] = true; assert.match((await command(malformed)).error, /^NOT_READY:/); malformed[field] = false;
    }
    assert.equal(malformed.storedReads, 0);
    for (const stored of [undefined, '', 'off', ' off ', 'dropbox', 'cloudkit']) {
        malformed.storedBackend = stored;
        const result = await command(malformed);
        assert.equal(result.ok, true); assert.equal(result.value.ok, false); assert.equal(result.value.error.code, 'ACTION_FAILED');
        assert.equal(malformed.storedBackend, stored);
    }
    assert.equal(malformed.syncFactoryCalls, 0); assert.equal(malformed.secretReads, 0); assert.equal(malformed.projectOptionsReads ?? 0, 0);
    assert.equal(markerLines(malformed).length, 0);
    const noIos = create('android'); assert.equal((await boot(noIos)).ok, true);
    assert.match((await command(noIos)).error, /^NOT_READY:/); assert.equal(noIos.syncFactoryCalls, 0);

    const stale = create(); assert.equal((await boot(stale)).ok, true);
    const staleCases = [
        () => ({ ...input, revision: 'older-revision' }),
        () => { stale.ownerProjects = []; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, deletedAt: 'deleted', attachments: [attachment] }]; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, purgedAt: 'purged', attachments: [attachment] }]; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, attachments: [{ ...attachment, kind: 'link' }] }]; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, attachments: [{ ...attachment, deletedAt: 'deleted' }] }]; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, attachments: [{ ...attachment, id: 'replacement' }] }]; return input; },
        () => { stale.ownerProjects = [{ id: input.projectId, attachments: [attachment, attachment] }]; return input; },
    ];
    for (const replace of staleCases) {
        const result = await command(stale, replace());
        assert.equal(result.ok, true); assert.equal(result.value.ok, false); assert.equal(result.value.error.code, 'STALE_REVISION');
    }
    assert.equal(stale.syncFactoryCalls, 0); assert.equal(stale.secretReads, 0); assert.equal(stale.attachmentInputs.length, 0);
    assert.equal(markerLines(stale).length, 0);

    const selected = create(); assert.equal((await boot(selected)).ok, true);
    const localHost = selected.contractBindings.attachments;
    assert.notEqual(localHost, selected.remoteAttachmentHost);
    const rowsBefore = JSON.stringify(selected.ownerProjects);
    assert.deepEqual(await command(selected), { ok: true, value: selected.attachmentReply });
    assert.equal(selected.syncFactoryCalls, 1); assert.equal(selected.downloadHosts[0], selected.remoteAttachmentHost);
    assert.equal(selected.contractBindings.attachments, localHost, 'Successful download restores the local-only host');
    assert.equal(JSON.stringify(selected.ownerProjects), rowsBefore);
    assert.equal(JSON.stringify(selected.attachmentInputs[0]), JSON.stringify(['downloadAttachment', { owner: { kind: 'project', projectId: input.projectId }, attachmentId: input.attachmentId }]));
    assert.equal(markerLines(selected).length, 1, 'Forced availability marker is persisted with diagnostics disabled');
    const marker = JSON.parse(markerLines(selected)[0]);
    assert.deepEqual(marker.context, { releaseCheck: 'v1.3.5/ios-project-file-download', operation: 'projectAttachmentDownload', outcome: 'available' });
    assert.equal(marker.message, 'Native iOS Project file availability settled');
    for (const privateValue of [input.projectId, input.attachmentId, input.revision, attachment.title, attachment.uri]) assert(!markerLines(selected)[0].includes(privateValue));
    selected.ownerProjects[0].status = 'archived';
    assert.deepEqual(await command(selected), { ok: true, value: selected.attachmentReply });
    assert.equal(selected.syncFactoryCalls, 1, 'The same retained factory handles archived availability');
    assert.equal(selected.contractBindings.attachments, localHost);
    selected.logFailure = 'synthetic log refusal';
    assert.deepEqual(await command(selected), { ok: true, value: selected.attachmentReply });
    assert.equal(markerLines(selected).length, 2, 'A failed log append cannot invalidate durable availability');
    selected.logFailure = null;
    for (const answer of [{ ok: true, value: { status: 'unavailable', message: 'synthetic refusal', update: null } },
        { ok: false, error: { code: 'ACTION_FAILED', message: 'synthetic host refusal' } }]) {
        selected.attachmentReply = answer; const count = markerLines(selected).length;
        assert.deepEqual(await command(selected), { ok: true, value: answer });
        assert.equal(markerLines(selected).length, count);
        assert.equal(selected.contractBindings.attachments, localHost);
    }
    selected.downloadError = 'synthetic download failure';
    assert.match((await command(selected)).error, /synthetic download failure/);
    assert.equal(selected.contractBindings.attachments, localHost, 'Thrown download restores the local-only host');
    selected.downloadError = null;
    const general = await poll(selected, selected.MindwtrHost.attachmentRequest('downloadAttachment', JSON.stringify({ owner: { kind: 'project', projectId: input.projectId }, attachmentId: input.attachmentId })));
    assert.equal(general.ok, false, 'General local attachment download remains closed');

    const draining = create(); assert.equal((await boot(draining)).ok, true);
    const drainingLocalHost = draining.contractBindings.attachments;
    let releaseDownload, releaseFlush;
    draining.downloadHold = new Promise((resolveHold) => { releaseDownload = resolveHold; });
    draining.flushHold = new Promise((resolveHold) => { releaseFlush = resolveHold; });
    const ticket = draining.MindwtrHost.iosForegroundSync('projectAttachmentDownload', JSON.stringify(input), () => '');
    await new Promise((tick) => setImmediate(tick));
    assert.equal(draining.MindwtrHost.poll(ticket), null);
    assert.equal(draining.contractBindings.attachments, draining.remoteAttachmentHost);
    assert.match((await command(draining)).error, /^NOT_READY:/, 'The current invocation excludes another command');
    releaseDownload(); await new Promise((tick) => setImmediate(tick));
    assert.equal(draining.contractBindings.attachments, drainingLocalHost);
    assert.notEqual(draining.contractBindings.attachments, draining.remoteAttachmentHost, 'Scope is restored before durable flush');
    assert.equal(draining.MindwtrHost.poll(ticket), null, 'No result before the durable barrier settles');
    assert.equal(markerLines(draining).length, 0);
    releaseFlush(); assert.deepEqual(await poll(draining, ticket), { ok: true, value: draining.attachmentReply });
    for (const flag of ['failed', 'queued', 'inFlight', 'immediate', 'retrying']) {
        const failure = create(); assert.equal((await boot(failure)).ok, true);
        const originalHost = failure.contractBindings.attachments;
        failure.afterDownload = () => { failure.persistenceStatus = { [flag]: true }; };
        assert.match((await command(failure)).error, /^NOT_READY:/);
        assert.equal(failure.contractBindings.attachments, originalHost); assert.equal(markerLines(failure).length, 0);
    }
    const flushFailure = create(); assert.equal((await boot(flushFailure)).ok, true);
    const originalHost = flushFailure.contractBindings.attachments;
    flushFailure.flushError = 'synthetic durable failure';
    assert.match((await command(flushFailure)).error, /synthetic durable failure/);
    assert.equal(flushFailure.contractBindings.attachments, originalHost); assert.equal(markerLines(flushFailure).length, 0);
    const fatal = create(); assert.equal((await boot(fatal)).ok, true);
    fatal.downloadFatal = true;
    assert.match((await command(fatal)).error, /cleanup could not be confirmed/i);
    const counts = [fatal.storedReads, fatal.attachmentInputs.length, fatal.events.length];
    assert.match((await command(fatal)).error, /cleanup could not be confirmed/i);
    assert.deepEqual([fatal.storedReads, fatal.attachmentInputs.length, fatal.events.length], counts);
    assert.equal(markerLines(fatal).length, 0);
    console.log('Task346: strict selected Project Download admission, archived eligibility, scoped host restoration and durable availability acknowledgment (NodeVM)');
}
// Production host-entry selects independent local attachment policy only for
// complete iOS file capabilities. No kvMultiGet, sync settings, AI or backend
// constructor is supplied; readiness and diagnostic acknowledgments are real.
{
    const configureLocal = (state) => {
        state.localAttachmentTest = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null;
        state.__mindwtrInstallerCall = async () => null;
    };
    // Stored Sync's empty/Off admission must not construct the throwing Sync
    // stand-ins, read secrets, or open a form. Actual configured runs use JSC tests.
    const stored = makeState(0, [], 'ios', (state) => {
        configureLocal(state);
        state.storedReads = 0; state.secretReads = 0;
        state.__mindwtrNative.kvMultiGet = () => { throw new Error('Unexpected stored multi-read'); };
        state.__mindwtrNative.kvGet = (key) => {
            assert.equal(key, '@mindwtr_sync_backend');
            state.storedReads++;
            return JSON.stringify([state.storedBackend ?? null]);
        };
        state.__mindwtrSyncSecrets = { getSecret: () => {
            state.secretReads++; throw new Error('Unexpected stored secret read');
        } };
    });
    for (const name of ['syncStored', 'syncResume']) {
        assert.match((await poll(stored, stored.MindwtrHost.iosForegroundSync(name, '{}', () => ''))).error, /^NOT_READY:/);
    }
    assert.equal(stored.storedReads, 0);
    assert.equal((await poll(stored, stored.MindwtrHost.boot())).ok, true);
    for (const name of ['syncStored', 'syncResume']) {
        const command = (json = '{}') => poll(stored, stored.MindwtrHost.iosForegroundSync(name, json, () => ''));
        stored.storedReads = 0;
        stored.storedBackend = undefined;
        for (const input of ['null', '[]', '{', '{"revision":"r"}', '{"config":{}}', '{"password":"synthetic"}', '{"x":"' + 'x'.repeat(128 * 1024) + '"}']) {
            assert.match((await command(input)).error, /^INVALID_INPUT:/, `${name} accepts only a bounded empty object`);
        }
        assert.equal(stored.storedReads, 0, 'Invalid requests reach no storage port');
        for (const flag of ['failed', 'queued', 'inFlight', 'immediate', 'retrying']) {
            stored.persistenceStatus = { [flag]: true };
            assert.match((await command()).error, /^NOT_READY:/, `${name} preserves strict persistence admission`);
        }
        stored.persistenceStatus = null;
        for (const field of ['sandbox', 'workspaceTransition']) {
            stored[field] = true;
            assert.match((await command()).error, /^NOT_READY:/);
            stored[field] = false;
        }
        assert.equal(stored.storedReads, 0, 'Unsettled requests reach no storage port');
        const beforeRows = JSON.stringify(stored.fakeData);
        const beforeLog = stored.logText;
        for (const value of [undefined, '', 'off', ' off ']) {
            stored.storedBackend = value;
            assert.deepEqual(await command('  {}  '), { ok: true, value: { ok: true, value: { success: true, skipped: true } } });
        }
        stored.storedBackend = 'dropbox';
        const unsupported = await command();
        assert.equal(unsupported.ok, true);
        assert.equal(unsupported.value.ok, false);
        assert.equal(unsupported.value.error.code, 'ACTION_FAILED');
        assert.equal(stored.storedBackend, 'dropbox', 'Unsupported stored provider is preserved');
        assert.equal(stored.storedReads, 5, 'One exact provider read per admitted invocation');
        assert.equal(stored.secretReads, 0, 'Off and unsupported runs read no secret');
        assert.equal(JSON.stringify(stored.fakeData), beforeRows, 'Off admission writes no domain rows');
        assert.equal(stored.logText, beforeLog, 'No configured-run settlement marker is emitted for skipped/refused admission');
        assert.equal(stored.contractBindings.syncSettings, undefined, 'Off and unsupported runs never construct the Sync factory');
    }
    assert.ok(hostEntry.includes("name === 'syncResume' ? { message: 'Native iOS resume Sync command settled', releaseCheck: 'v1.3.5/ios-resume-sync' }"));
    assert.match(hostEntry, /context: \{ releaseCheck: diagnostic\.releaseCheck, operation: name, outcome:/);
    const local = makeState(0, [], 'ios', configureLocal);
    assert.deepEqual(Object.keys(local.contractBindings).filter((name) => local.contractBindings[name] !== undefined), ['reminderPlatform', 'attachments'], 'local capability enables neither Sync nor AI');
    assert.equal(local.localShaInstallCount, 1, 'successful local construction installs native SHA once');
    assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
    const owner = { kind: 'task', taskId: 'task215', attachments: [] };
    const markerLines = () => (local.logText ?? '').split('\n').filter((line) => line.includes('v1.3.4/ios-local-attachment-host'));
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('draftRemove', JSON.stringify({ owner })))).ok, true);
    assert.equal(markerLines().length, 1, 'one forced marker follows an acknowledged task draft operation');
    const marker = JSON.parse(markerLines()[0]);
    assert.deepEqual(marker.context, { releaseCheck: 'v1.3.4/ios-local-attachment-host', operation: 'draftRemove', outcome: 'completed' });
    assert(!markerLines()[0].includes('task215'), 'diagnostic has no task ID or request body');
    local.localTaskReadOnly = true;
    const beforeInputs = local.attachmentInputs.length;
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('draftAddFile', JSON.stringify({ owner })))).ok, false);
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('draftRemove', JSON.stringify({ owner })))).ok, false);
    assert.equal(local.attachmentInputs.length, beforeInputs, 'read-only task cannot enter copy/remove policy');
    local.attachmentReply = { ok: true, value: { status: 'available', open: { kind: 'file' } } };
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('openAttachment', JSON.stringify({ owner })))).ok, true,
        'read-only task can still ask shared Open policy');
    local.attachmentReply = { ok: true, value: { deleted: 0 } };
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('settleTaskDraftAttachments', '{}'))).ok, true,
        'stale/read-only draft settlement remains owned by shared latest-keep policy');
    local.localTaskReadOnly = false;
    local.localTaskViewFailure = { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } };
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('draftAddFile', JSON.stringify({ owner })))).ok, false);
    local.localTaskViewFailure = null;
    const successfulMarkers = markerLines().length;
    for (const reply of [{ ok: false, error: { code: 'ACTION_FAILED', message: 'refused' } },
        { ok: true, value: { kind: 'refused' } }, { ok: true, value: { kind: 'blocked' } }]) {
        local.attachmentReply = reply;
        await poll(local, local.MindwtrHost.attachmentRequest('draftAddFile', JSON.stringify({ owner })));
    }
    local.attachmentReply = { ok: true, value: { status: 'unavailable' } };
    await poll(local, local.MindwtrHost.attachmentRequest('openAttachment', JSON.stringify({ owner })));
    assert.equal(markerLines().length, successfulMarkers, 'refused/blocked/unavailable operations emit no success marker');
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('openAttachment', JSON.stringify({ owner: { kind: 'project', projectId: 'p' } })))).ok, false);
    assert.equal((await poll(local, local.MindwtrHost.attachmentRequest('downloadAttachment', JSON.stringify({ owner })))).ok, false);
    local.persistenceFailure = { message: 'previous save failed' };
    assert.match((await poll(local, local.MindwtrHost.attachmentRequest('draftRemove', JSON.stringify({ owner })))).error, /SAVE_FAILED/);
    assert.equal(markerLines().length, successfulMarkers);
    assert(local.fileCalls.every((call) => !call.startsWith('kv')), 'local requests never touch RN device storage');
    for (const variant of ['partial', 'refused', 'android']) {
        const unavailable = makeState(0, [], variant === 'android' ? undefined : 'ios', (state) => {
            configureLocal(state);
            if (variant === 'partial') delete state.__mindwtrNative.ioBody;
            if (variant === 'refused') state.__mindwtrNative.fileDirectories = () => '!MindwtrNativeError:fixed unavailable';
        });
        assert.deepEqual(Object.keys(unavailable.contractBindings).filter((name) => unavailable.contractBindings[name] !== undefined), ['reminderPlatform'], `${variant} capability offers no local fallback`);
        assert.equal(unavailable.localShaInstallCount, 0, 'failed optional discovery leaves SHA binding unchanged');
        assert.equal((await poll(unavailable, unavailable.MindwtrHost.boot())).ok, true, 'optional local failure does not fail boot');
    }
}
// Task257: actual V3 pure helpers through production submit/poll. Save stand-ins
// prove routing/transport only; the real 254 factory/CAS is covered in core tests.
{
    const configureLocal = (state) => {
        state.localAttachmentTest = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null;
        state.__mindwtrInstallerCall = async () => null;
    };
    const ROOT = 'file:///library/documents/attachments/';
    const AT = '2026-10-05T00:00:00.000Z';
    const baseline = { id: 'baseline', kind: 'file', title: 'Original', uri: ROOT + 'baseline.pdf', createdAt: AT, updatedAt: AT };
    const opening = JSON.stringify({ version: 2, taskID: 'task257', attachmentsOwned: true,
        attachmentsBase: [baseline], attachments: [baseline], raw: { notes: 'Retain opaque checkpoint' } });
    const begin = { taskID: 'task257', payloadJSON: opening };
    const lineage = { version: 3, taskID: 'task257', initialPayloadJSON: opening,
        beforePayloadJSON: opening, priorOperations: [], managedDirectoryURI: ROOT };
    const removeInput = { ...lineage, requestId: '25700000-0000-4000-8000-000000000001', attachmentId: 'baseline' };
    const addInput = { ...lineage, requestId: '25700000-0000-4000-8000-000000000002',
        picked: { uri: 'file:///library/cache/picked.pdf', name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 };
    let cases = 0;
    const check = async (action) => { await action(); cases++; };
    const call = (state, method, value) => poll(state, state.MindwtrHost[method](JSON.stringify(value)));
    const local = makeState(0, [], 'ios', configureLocal);
    assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
    await check(async () => assert.deepEqual(await call(local, 'attachmentDraftBeginV3', begin),
        { ok: true, value: { version: 3, taskID: 'task257', payloadJSON: opening } }));
    await check(async () => {
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-attachment-link-lineage', outcome: 'validated' });
        const beforeLog = local.logText;
        assert.equal((await call(local, 'attachmentDraftBeginV3', { ...begin, payloadJSON: '{}' })).ok, false);
        assert.equal(local.logText, beforeLog);
        local.logFailure = 'private log failure';
        assert.equal((await call(local, 'attachmentDraftBeginV3', begin)).ok, true);
        assert.equal(local.logText, beforeLog);
        local.logFailure = null;
    });
    await check(async () => {
        local.settings = { diagnostics: { loggingEnabled: false } };
        assert.deepEqual(await call(local, 'attachmentDraftBeginV4', begin),
            { ok: true, value: { version: 4, taskID: 'task257', payloadJSON: opening } });
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-attachment-link-lineage', outcome: 'validated' });
        const beforeLog = local.logText;
        assert.equal((await call(local, 'attachmentDraftBeginV4', { ...begin, payloadJSON: '{}' })).ok, false);
        assert.equal(local.logText, beforeLog);
        local.logFailure = 'private log failure';
        assert.equal((await call(local, 'attachmentDraftBeginV4', begin)).ok, true);
        assert.equal(local.logText, beforeLog); local.logFailure = null;
    });
    const removedReply = await call(local, 'attachmentDraftRemovePrepareV3', removeInput);
    assert.equal(removedReply.ok, true);
    const removed = removedReply.value;
    await check(async () => {
        assert.equal(removed.kind, 'prepared-file-remove'); assert.equal(removed.version, 1);
        assert.equal(removed.beforePayloadJSON, opening);
        assert.equal(new Date(removed.removedAt).toISOString(), removed.removedAt);
        assert.deepEqual(JSON.parse(removed.afterPayloadJSON).attachments,
            [{ ...baseline, deletedAt: removed.removedAt, updatedAt: removed.removedAt }]);
    });
    const mixed = { ...lineage, beforePayloadJSON: removed.afterPayloadJSON,
        priorOperations: [{ kind: 'remove', operation: removed }] };
    const addedReply = await call(local, 'attachmentDraftPrepareV3', { ...addInput, ...mixed });
    assert.equal(addedReply.ok, true);
    const added = addedReply.value;
    await check(async () => {
        assert.equal(added.kind, 'prepared'); assert.equal(added.beforePayloadJSON, removed.afterPayloadJSON);
        const final = { ...mixed, beforePayloadJSON: added.afterPayloadJSON,
            priorOperations: [...mixed.priorOperations, { kind: 'add', operation: added }] };
        assert.deepEqual(await call(local, 'attachmentDraftValidateLineageV3', final),
            { ok: true, value: { version: 3, taskID: 'task257', payloadJSON: added.afterPayloadJSON } });
        assert.deepEqual(JSON.parse(added.afterPayloadJSON).raw, JSON.parse(opening).raw);
    });
    await check(async () => {
        const selected = { ...lineage, version: 4 }, sha = 'a'.repeat(64);
        const reply = await call(local, 'attachmentDraftPrepareV4', { ...addInput, ...selected, sourceSha256: sha });
        assert.equal(reply.ok, true); const hashed = reply.value;
        assert.equal(hashed.version, 2); assert.equal(hashed.sourceSha256, sha);
        assert.equal(hashed.prepared.attachment.fileHash, sha); assert.equal(hashed.attachment.fileHash, sha);
        const full = { ...selected, beforePayloadJSON: hashed.afterPayloadJSON, priorOperations: [{ kind: 'add', operation: hashed }] };
        assert.deepEqual(await call(local, 'attachmentDraftValidateLineageV4', full),
            { ok: true, value: { version: 4, taskID: 'task257', payloadJSON: hashed.afterPayloadJSON } });
        assert.equal((await call(local, 'attachmentDraftValidateLineageV3', full)).ok, false);
        assert.equal((await call(local, 'attachmentDraftPrepareV3', { ...addInput, sourceSha256: sha })).ok, false);
        const removed = await call(local, 'attachmentDraftRemovePrepareV4', { ...full,
            requestId: '28800000-0000-4000-8000-000000000003', attachmentId: hashed.requestId });
        assert.equal(removed.ok, true); assert.equal(removed.value.version, 1);
        const discarded = { version: 3, historyVersion: 4, taskID: selected.taskID, managedDirectoryURI: ROOT,
            initialPayloadJSON: opening, checkpointPayloadJSON: removed.value.afterPayloadJSON,
            operations: [{ kind: 'add', phase: 'checkpointed', preparedJSON: JSON.stringify(hashed) },
                { kind: 'remove', phase: 'checkpointed', preparedJSON: JSON.stringify(removed.value) }] };
        const planned = await call(local, 'attachmentDraftDiscardCandidatesV4', discarded);
        assert.equal(planned.ok, true); assert.equal(planned.value.version, 3); assert.equal(planned.value.historyVersion, 4);
        assert.deepEqual(planned.value.candidates.map((value) => value.requestId), [hashed.requestId]);
        assert.equal((await call(local, 'attachmentDraftDiscardCandidatesV3', discarded)).ok, false);
        const wrong = structuredClone(full); wrong.priorOperations[0].operation.sourceSha256 = 'b'.repeat(64);
        assert.equal((await call(local, 'attachmentDraftValidateLineageV4', wrong)).ok, false);
    });
    // Selected availability metadata retains a baseline ID while acquiring a different URI.
    await check(async () => {
        const missing = { ...baseline, uri: '', cloudKey: 'attachments/baseline.pdf',
            fileHash: 'a'.repeat(64), localStatus: 'missing' };
        const before = { ...JSON.parse(opening), attachmentsBase: [missing], attachments: [missing] };
        const beforePayloadJSON = JSON.stringify(before);
        const resolved = { ...missing, uri: ROOT + 'baseline.pdf', localStatus: 'available' };
        const afterPayloadJSON = JSON.stringify({ ...before, attachments: [resolved] });
        const operation = { version: 1, kind: 'prepared-file-availability', taskID: 'task257',
            requestId: '35600000-0000-4000-8000-000000000001', attachmentId: missing.id,
            identity: JSON.stringify([missing.id, missing.cloudKey, missing.fileHash, 0]),
            beforePayloadJSON, afterPayloadJSON, status: 'available', resolvedAttachmentJSON: JSON.stringify(resolved) };
        const selected = { ...lineage, version: 5, initialPayloadJSON: beforePayloadJSON,
            beforePayloadJSON: afterPayloadJSON, priorOperations: [{ kind: 'availability', operation }] };
        const beforeFiles = structuredClone(local.fileCalls), beforeSaves = local.saveCount;
        assert.deepEqual(await call(local, 'attachmentDraftBeginV5', { ...begin, payloadJSON: beforePayloadJSON }),
            { ok: true, value: { version: 5, taskID: 'task257', payloadJSON: beforePayloadJSON } });
        assert.deepEqual(await call(local, 'attachmentDraftValidateLineageV5', selected),
            { ok: true, value: { version: 5, taskID: 'task257', payloadJSON: afterPayloadJSON } });
        for (const method of ['attachmentDraftValidateLineageV3', 'attachmentDraftValidateLineageV4']) {
            assert.equal((await call(local, method, selected)).ok, false);
        }
        const discarded = { version: 4, historyVersion: 5, taskID: 'task257', managedDirectoryURI: ROOT,
            initialPayloadJSON: beforePayloadJSON, checkpointPayloadJSON: afterPayloadJSON,
            operations: [{ kind: 'availability', phase: 'checkpointed', preparedJSON: JSON.stringify(operation) }] };
        const planned = await call(local, 'attachmentDraftDiscardCandidatesV5', discarded);
        assert.equal(planned.ok, true);
        assert.equal(planned.value.kind, 'owned-availability-discard-candidates');
        assert.deepEqual(planned.value.candidates, [{ requestId: operation.requestId,
            attachmentId: missing.id, targetURI: resolved.uri, reason: 'uncommitted-draft' }]);
        assert.equal((await call(local, 'attachmentDraftDiscardCandidatesV4', discarded)).ok, false);
        assert.deepEqual(local.fileCalls, beforeFiles, 'metadata continuity never installs or retires bytes');
        assert.equal(local.saveCount, beforeSaves, 'metadata continuity never saves the Task');
        const forged = structuredClone(selected);
        forged.priorOperations[0].operation.afterPayloadJSON = afterPayloadJSON.replace('Retain opaque checkpoint', 'forged');
        assert.equal((await call(local, 'attachmentDraftValidateLineageV5', forged)).ok, false);
    });
    // Historical retry has no optional capability, current editable task or fresh clock.
    const historical = makeState(0, [], 'ios'); historical.localTaskReadOnly = true;
    historical.sandbox = true; historical.workspaceTransition = true;
    historical.persistenceFailure = { message: 'not used by pure historical validation' };
    vm.runInNewContext(`globalThis.Date = class extends Date {
        constructor(...args) { if (!args.length) throw new Error('fresh clock forbidden'); super(...args); }
    };`, historical);
    await check(async () => assert.deepEqual(await call(historical, 'attachmentDraftValidateRemove', removed), { ok: true, value: removed }));
    await check(async () => assert.deepEqual(await call(historical, 'attachmentDraftValidateLineageV3', mixed),
        { ok: true, value: { version: 3, taskID: 'task257', payloadJSON: removed.afterPayloadJSON } }));
    for (const method of ['attachmentDraftValidateRemove', 'attachmentDraftValidateLineageV3', 'attachmentDraftValidateLineageV5', 'attachmentDraftDiscardCandidatesV5', 'attachmentFileEditSaveValidate']) {
        await check(async () => assert.match((await call(makeState(0), method, {})).error, /^NOT_READY:/));
    }
    for (const variant of ['nonIOS', 'noCapability', 'sandbox', 'workspace', 'readOnly', 'taskMissing', 'persistence']) {
        const state = makeState(0, [], variant === 'nonIOS' ? undefined : 'ios', variant === 'noCapability' ? undefined : configureLocal);
        if (variant === 'sandbox') state.sandbox = true;
        if (variant === 'workspace') state.workspaceTransition = true;
        if (variant === 'readOnly') state.localTaskReadOnly = true;
        if (variant === 'taskMissing') state.localTaskViewFailure = { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Not found' } };
        if (variant === 'persistence') state.persistenceFailure = { message: 'failed' };
        for (const [method, input] of [['attachmentDraftBeginV3', begin], ['attachmentDraftBeginV4', begin], ['attachmentDraftBeginV5', begin], ['attachmentDraftPrepareV3', addInput], ['attachmentDraftRemovePrepareV3', removeInput]]) {
            await check(async () => assert.equal((await call(state, method, input)).ok, false, `${variant}/${method}`));
        }
        if (variant !== 'readOnly' && variant !== 'taskMissing') {
            for (const method of ['attachmentFileEditSavePrepare', 'attachmentFileEditSaveCommit']) {
                if (variant === 'persistence' && method.endsWith('Commit')) continue; // Commit delegates persistence/CAS readiness to the real core factory.
                await check(async () => assert.equal((await call(state, method, {})).ok, false, `${variant}/${method}`));
            }
            assert.equal(state.fileEditSaveInputs.length, 0, 'fresh admission refusal does not reach the Save stand-in');
        }
    }
    await check(async () => {
        const state = makeState(0, [], 'ios', configureLocal);
        const ticket = state.MindwtrHost.attachmentDraftPrepareV3(JSON.stringify(addInput));
        state.localTaskReadOnly = true;
        assert.equal((await poll(state, ticket)).ok, false, 'Add checks current task again after async upload policy');
    });
    for (const method of ['attachmentDraftBeginV3', 'attachmentDraftValidateLineageV3', 'attachmentDraftPrepareV3',
        'attachmentDraftRemovePrepareV3', 'attachmentDraftValidateRemove', 'attachmentFileEditSavePrepare',
        'attachmentFileEditSaveValidate', 'attachmentFileEditSaveCommit']) {
        await check(async () => assert.deepEqual(await poll(local, local.MindwtrHost[method]('{private-content')),
            { ok: false, error: 'INVALID_INPUT' }));
    }
    await check(async () => {
        const before = local.fileEditSaveInputs.length;
        for (const json of ['x'.repeat(8 * 1024 * 1024 + 1), JSON.stringify({ secret: '界'.repeat(3 * 1024 * 1024) })]) {
            assert.deepEqual(await poll(local, local.MindwtrHost.attachmentFileEditSaveValidate(json)), { ok: false, error: 'INVALID_INPUT' });
        }
        assert.equal(local.fileEditSaveInputs.length, before, 'actual UTF8 byte limit refuses before contract dispatch');
    });
    // Complete frozen changed/noop plans and outcomes travel untouched; no plan clipping.
    for (const kind of ['changed', 'noop']) {
        const request = { version: 1, kind: 'owned-editor-file-edit-save', opaque: kind };
        const prepared = { version: 1, kind: 'owned-editor-file-edit-save', request, decision: { kind } };
        for (const [method, routed, value] of [
            ['attachmentFileEditSavePrepare', 'prepare', { kind: 'prepared', prepared }],
            ['attachmentFileEditSaveValidate', 'validate', { version: 1, kind: 'owned-editor-file-edit-save',
                result: { id: 'task257', draft: { title: kind } }, settlementPlan: Array.from({ length: 257 }, (_, n) => ({ id: String(n), uri: ROOT + n })) }],
            ['attachmentFileEditSaveCommit', 'commit', { id: 'task257', draft: { title: kind } }],
        ]) {
            await check(async () => {
                local.fileEditSaveReply = { ok: true, value };
                const input = routed === 'prepare' ? request : { request, prepared };
                assert.deepEqual(await call(local, method, input), { ok: true, value });
                assert.deepEqual(JSON.parse(JSON.stringify(local.fileEditSaveInputs.at(-1))), [routed, input]);
            });
        }
    }
    await check(async () => {
        const value = { original: true }; historical.fileEditSaveReply = { ok: true, value };
        const envelope = { request: { version: 1 }, prepared: { version: 1 } };
        assert.deepEqual(await call(historical, 'attachmentFileEditSaveValidate', envelope), { ok: true, value });
        assert.deepEqual(JSON.parse(JSON.stringify(historical.fileEditSaveInputs)), [['validate', envelope]]);
    });
    for (const [method, routed] of [['attachmentOwnedSavePrepare', 'legacyPrepare'], ['attachmentOwnedSaveValidate', 'legacyValidate'], ['attachmentOwnedSaveCommit', 'legacyCommit']]) {
        await check(async () => { await call(local, method, {}); assert.deepEqual(JSON.parse(JSON.stringify(local.fileEditSaveInputs.at(-1))), [routed, {}]); });
    }
    await check(async () => {
        for (const name of ['attachmentDraftBeginV3', 'attachmentDraftRemovePrepareV3', 'attachmentFileEditSaveCommit']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentRequest(name, '{}'))).ok, false, 'private methods are not generic attachment request allowlist additions');
        }
        assert.equal(local.attachmentInputs.length, 0);
        assert(!(local.logText ?? '').includes('mixed-draft'), 'binding dispatch is not a native acknowledgment');
    });
    console.log(`Task257: ${cases} private mixed-draft binding/transport checks (real pure V3 helpers; Save dispatch stand-ins only)`);
}
// Task259: direct Save fence with real254 pure file-only validation and actual
// shared reference/revision policy. No native proof owner or JSC claim.
{
    const configureLocal = (state) => {
        state.localAttachmentTest = true;
        state.realMixedSaveValidation = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null; state.__mindwtrInstallerCall = async () => null;
    };
    const ROOT = 'file:///library/documents/attachments/', AT = '2026-10-05T00:00:00.000Z';
    const SESSION = '25900000-0000-4000-8000-000000000001';
    const REQUEST = '25900000-0000-4000-8000-000000000002';
    let cases = 0;
    const check = async (work) => { await work(); cases++; };
    const fixtureState = makeState(0, [], 'ios', configureLocal);
    assert.equal((await poll(fixtureState, fixtureState.MindwtrHost.boot())).ok, true);
    const fixtures = new Map();
    const fixture = async (count = 1, kind = 'noop', managedDirectoryURI = ROOT) => {
        const key = `${count}:${kind}:${managedDirectoryURI}`;
        if (fixtures.has(key)) return fixtures.get(key);
        const baseline = Array.from({ length: count }, (_, n) => ({ id: `baseline${n}`, kind: 'file', title: 'File',
            uri: managedDirectoryURI + `baseline${n}.pdf`, createdAt: AT, updatedAt: AT, ...(n ? { deletedAt: AT } : {}) }));
        const initialPayloadJSON = JSON.stringify({ version: 2, taskID: 'task259', tab: 'task', touchedBase: {}, edited: {},
            raw: { title: '', note: '', location: '', estimate: '', estimateResolved: '', timeSpent: '', timeSpentResolved: '',
                tokens: {}, tokenCanonical: {}, tokenResolved: {}, tokenEdited: [], checklistInputs: {}, checklistAppend: '',
                relativeAmount: '', relativeUnit: '', relativeOwned: false, relativeCommitRequested: false,
                recurrenceInputs: {}, recurrenceOwned: [], recurrenceCommitRequested: [] }, scheduleEdits: [], scheduleFailedID: null,
            attachmentsOwned: true, attachmentsBase: baseline, attachments: baseline, linkSheet: {} });
        const owned = { version: 3, taskID: 'task259', initialPayloadJSON, beforePayloadJSON: initialPayloadJSON,
            priorOperations: [], managedDirectoryURI };
        const removed = await poll(fixtureState, fixtureState.MindwtrHost.attachmentDraftRemovePrepareV3(JSON.stringify({ ...owned,
            requestId: REQUEST, attachmentId: baseline[0].id })));
        assert.equal(removed.ok, true);
        const op = removed.value, draft = JSON.parse(op.afterPayloadJSON).attachments;
        const saveRequest = { id: 'task259', base: {}, patch: {},
            scheduleBase: { startTime: null, dueDate: null, relativeStartOffset: null, reviewAt: null }, attachments: { base: baseline, value: draft } };
        const request = { version: 1, kind: 'owned-editor-file-edit-save',
            checkpoint: { version: 1, sessionID: SESSION, taskID: 'task259', generation: 2, payloadJSON: op.afterPayloadJSON },
            ownedDraft: { ...owned, beforePayloadJSON: op.afterPayloadJSON, priorOperations: [{ kind: 'remove', operation: op }] }, saveRequest };
        const before = { id: 'task259', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before',
            attachments: kind === 'noop' ? draft : baseline };
        const after = kind === 'noop' ? before : { ...before, attachments: draft, updatedAt: op.removedAt, rev: 9, revBy: 'device' };
        const scope = { sourceProject: null, targetProject: null, targetSection: null, targetArea: null, nextProjectOrder: null };
        const decision = kind === 'noop' ? { kind, preparedAt: op.removedAt, deviceIdBefore: 'device', scope, effect: { task: { before, after } } }
            : { kind, prepared: { version: 2, request: saveRequest, preparedAt: op.removedAt, deviceIdBefore: 'device',
                deviceIdToInitialize: null, scope, effect: { task: { before, after } } } };
        const envelope = { request, prepared: { version: 1, kind: 'owned-editor-file-edit-save', request, decision } };
        const validation = await poll(fixtureState, fixtureState.MindwtrHost.attachmentFileEditSaveValidate(JSON.stringify(envelope)));
        assert.equal(validation.ok, true, 'real254 validates the full file-only checkpoint/noop or changed effect');
        assert.equal(validation.value.settlementPlan.length, count);
        const value = { envelope, after, plan: validation.value.settlementPlan };
        fixtures.set(key, value); return value;
    };
    const plain = await fixture(), changed = await fixture(1, 'changed'), many = await fixture(257);
    const make = async (f = plain, configure = configureLocal, platform = 'ios') => {
        const state = makeState(0, [], platform, configure);
        assert.equal((await poll(state, state.MindwtrHost.boot())).ok, true);
        state.lastLoaded.tasks = [JSON.parse(JSON.stringify(f.after))];
        state.ownerTaskMap = new Map([[f.after.id, state.lastLoaded.tasks[0]]]);
        state.persistenceStatus = { generation: 0, queued: false, inFlight: false, immediate: false, retrying: false, failed: false };
        return state;
    };
    const input = (f = plain, index = 0) => JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(f.envelope), candidateIndex: index });
    const invoke = (state, json = input(), outcome = 'removed') => {
        const seen = [];
        const callback = (label) => function () { assert.equal(arguments.length, 0); seen.push(label); return JSON.stringify({ outcome: label === 'retire' ? outcome : label }); };
        const value = state.MindwtrHost.attachmentFileEditSaveRetire(json, callback('referenced'), callback('taskChanged'), callback('retire'));
        return { value: JSON.parse(value), seen };
    };
    for (const f of [plain, changed, many]) await check(async () => {
        const state = await make(f), before = state.fileEditSaveInputs.length;
        assert.deepEqual(invoke(state, input(f, f.plan.length - 1)), { value: { outcome: 'removed' }, seen: ['retire'] });
        assert.equal(state.fileEditSaveInputs.length - before, 1, 'full frozen envelope is validated once before candidate selection');
    });
    // Task263: reuse only the exact immutable envelope/plan, with current gates
    // and branch selection exercised again on each cache hit.
    const reuse = await fixture(3), validations = (state) => state.fileEditSaveInputs.filter(([method]) => method === 'validate').length;
    let memoCases = 0;
    const checkMemo = async (work) => { await check(work); memoCases++; };
    await checkMemo(async () => {
        const state = await make(many);
        for (let index = 0; index < many.plan.length; index++) {
            assert.deepEqual(invoke(state, input(many, index)), { value: { outcome: 'removed' }, seen: ['retire'] });
        }
        assert.equal(validations(state), 1, 'all 257 candidates share one complete pure validation');
        invoke(state, input(many));
        assert.equal(validations(state), 2, 'the last candidate released the historical memo');
    });
    await checkMemo(async () => {
        const state = await make(reuse);
        for (const index of [1, 0, 1]) invoke(state, input(reuse, index));
        assert.equal(validations(state), 1, 'nonlast reordering retains only one immutable plan');
        invoke(state, input(reuse, 2)); invoke(state, input(reuse));
        assert.equal(validations(state), 2, 'a call after the last index fully revalidates');
    });
    await checkMemo(async () => {
        const state = await make(reuse), raw = JSON.stringify(reuse.envelope);
        for (const envelopeJSON of [raw, ` ${raw}\n`, raw.replaceAll('task259', 't\\u0061sk259'), raw]) {
            assert.deepEqual(invoke(state, JSON.stringify({ version: 1, envelopeJSON, candidateIndex: 0 })),
                { value: { outcome: 'removed' }, seen: ['retire'] });
        }
        assert.equal(validations(state), 4, 'whitespace and equivalent Unicode escaping are different exact envelope bytes');
    });
    await checkMemo(async () => {
        const state = await make(reuse); invoke(state, input(reuse));
        const forged = JSON.parse(JSON.stringify(reuse.envelope));
        forged.request.ownedDraft.priorOperations[0].operation.requestId += '\n'; forged.prepared.request = forged.request;
        assert.throws(() => invoke(state, JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(forged), candidateIndex: 1 })),
            /INVALID_INPUT: Invalid attachment Save handoff/);
        assert.equal(validations(state), 2, 'a different history reaches full validation and cannot borrow the previous plan');
        for (const json of [JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(reuse.envelope), candidateIndex: 3 }),
            JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(reuse.envelope), candidateIndex: 1, permission: true }),
            JSON.stringify({ version: 1, envelopeJSON: '界'.repeat(3 * 1024 * 1024), candidateIndex: 1 }), '{private']) {
            assert.throws(() => invoke(state, json), /INVALID_INPUT: Invalid attachment Save handoff/);
        }
        assert.deepEqual(invoke(state, input(reuse, 1)), { value: { outcome: 'removed' }, seen: ['retire'] });
        assert.equal(validations(state), 2, 'invalid frames/indexes do not replace the previously validated exact plan');
    });
    await checkMemo(async () => {
        const state = await make(reuse); invoke(state, input(reuse));
        state.ownerProjects = [{ attachments: [{ kind: 'file', uri: reuse.plan[1].attachment.uri }] }];
        assert.deepEqual(invoke(state, input(reuse, 1)), { value: { outcome: 'referenced' }, seen: ['referenced'] });
        state.ownerProjects = []; state.ownerTaskMap = new Map([['task259', { ...reuse.after, rev: reuse.after.rev + 1 }]]);
        assert.deepEqual(invoke(state, input(reuse, 1)), { value: { outcome: 'taskChanged' }, seen: ['taskChanged'] });
        state.ownerTaskMap = new Map([['task259', reuse.after]]);
        assert.deepEqual(invoke(state, input(reuse, 1)), { value: { outcome: 'removed' }, seen: ['retire'] });
        assert.equal(validations(state), 1, 'references/current revision and callback choice stay fresh on hits');
    });
    for (const field of ['queued', 'inFlight', 'immediate', 'retrying', 'failed']) await checkMemo(async () => {
        const state = await make(reuse); invoke(state, input(reuse)); state.persistenceStatus[field] = true;
        assert.throws(() => invoke(state, input(reuse, 1)), /NOT_READY: Attachment Save requires settled native storage/);
        state.persistenceStatus[field] = false; invoke(state, input(reuse, 1));
        assert.equal(validations(state), 1, 'readiness refusal never turns the immutable memo into a permission');
    });
    for (const field of ['tasks', 'projects', 'map', 'generation', 'queued', 'sandbox', 'adapter']) await checkMemo(async () => {
        const state = await make(reuse); invoke(state, input(reuse));
        const row = { id: 'cache-hit-inert' };
        Object.defineProperty(row, 'attachments', { get() {
            if (field === 'tasks') state.lastLoaded.tasks = [...state.lastLoaded.tasks];
            if (field === 'projects') state.ownerProjects = [];
            if (field === 'map') state.ownerTaskMap = new Map(state.ownerTaskMap);
            if (field === 'generation') state.persistenceStatus.generation++;
            if (field === 'queued') state.persistenceStatus.queued = true;
            if (field === 'sandbox') state.sandbox = true;
            if (field === 'adapter') state.adapter = {};
            return [];
        } });
        state.lastLoaded.tasks.push(row);
        assert.throws(() => invoke(state, input(reuse, 1)), /NOT_READY: Attachment Save requires settled native storage/);
        assert.equal(validations(state), 1, 'collection/map/generation fences are still checked on hits');
    });
    await checkMemo(async () => {
        const state = await make(reuse); invoke(state, input(reuse)); const json = input(reuse, 1);
        assert.throws(() => state.MindwtrHost.attachmentFileEditSaveRetire(json, () => '{}', () => '{}', () => '{}'),
            /INVALID_INPUT: Invalid attachment Save handoff/);
        assert.deepEqual(invoke(state, json), { value: { outcome: 'removed' }, seen: ['retire'] });
        assert.equal(validations(state), 1, 'a refused callback caches neither callback nor outcome');
        assert.throws(() => state.MindwtrHost.attachmentFileEditSaveRetire(input(reuse, 2), () => '{}', () => '{}', () => { throw Error('private'); }),
            /NOT_READY: Attachment Save requires settled native storage/);
        invoke(state, input(reuse, 2));
        assert.equal(validations(state), 2, 'a failed last callback still releases the memo before retry');
    });
    console.log(`Task263: ${memoCases} immutable Save-plan reuse checks (real254 complete plan; fresh mutable fences on cache hits)`);
    for (const outcome of ['removed', 'absent', 'generationChanged', 'unsafeEntry', 'noOwnedGeneration', 'unmanaged']) await check(async () => {
        assert.deepEqual(invoke(await make(), input(), outcome), { value: { outcome }, seen: ['retire'] });
    });
    for (const where of ['task', 'project', 'archived', 'deletedOwner', 'deletedAttachment', 'link']) await check(async () => {
        const state = await make(), attachment = { kind: where === 'link' ? 'link' : 'file', uri: plain.plan[0].attachment.uri,
            ...(where === 'deletedAttachment' ? { deletedAt: AT } : {}) };
        const owner = { id: 'other', attachments: [attachment], ...(where === 'deletedOwner' ? { deletedAt: AT } : {}),
            ...(where === 'archived' ? { status: 'archived' } : {}) };
        (where === 'project' ? state.ownerProjects : state.lastLoaded.tasks).push(owner);
        const kept = ['task', 'project', 'archived'].includes(where);
        assert.deepEqual(invoke(state), { value: { outcome: kept ? 'referenced' : 'removed' }, seen: [kept ? 'referenced' : 'retire'] });
    });
    // Task276: extra lexical system-alias comparisons can only keep a file.
    // Full pure envelopes and the same mutable generation fence remain in use.
    let aliasCases276 = 0;
    const checkAlias276 = async (work) => { await check(work); aliasCases276++; };
    const aliasSuffix276 = 'mobile/Containers/Data/Application/27600000-0000-4000-8000-000000000001/Library/attachment-files/documents/attachments/';
    for (const [prefix, otherPrefix] of [['file:///var/', 'file:///private/var/'], ['file:///private/var/', 'file:///var/']]) {
        const f = await fixture(1, 'noop', prefix + aliasSuffix276);
        const aliasURI = f.plan[0].attachment.uri.replace(prefix, otherPrefix);
        for (const where of ['task', 'project', 'deletedOwner', 'deletedAttachment']) await checkAlias276(async () => {
            const state = await make(f), attachment = { kind: 'file', uri: aliasURI,
                ...(where === 'deletedAttachment' ? { deletedAt: AT } : {}) };
            const owner = { id: 'alias-owner', attachments: [attachment], ...(where === 'deletedOwner' ? { deletedAt: AT } : {}) };
            (where === 'project' ? state.ownerProjects : state.lastLoaded.tasks).push(owner);
            const kept = where === 'task' || where === 'project';
            assert.deepEqual(invoke(state, input(f)), { value: { outcome: kept ? 'referenced' : 'removed' }, seen: [kept ? 'referenced' : 'retire'] });
        });
        await checkAlias276(async () => {
            const state = await make(f); let reads = 0, entered = 0;
            const owner = { id: 'alias-generation-change' };
            Object.defineProperty(owner, 'attachments', { get() {
                if (++reads === 2) state.persistenceStatus.generation++;
                return [{ kind: 'file', uri: aliasURI }];
            } });
            state.ownerProjects.push(owner);
            const callback = () => { entered++; return '{"outcome":"referenced"}'; };
            assert.throws(() => state.MindwtrHost.attachmentFileEditSaveRetire(input(f), callback, callback, callback),
                /NOT_READY: Attachment Save requires settled native storage/);
            assert(reads >= 2, 'mutation occurs during the sibling-alias reference comparison');
            assert.equal(entered, 0, 'alias comparison never releases the captured generation fence');
        });
    }
    for (const [prefix, otherPrefix] of [['file:///variant/', 'file:///private/variant/'], ['file:///private/variant/', 'file:///variant/']]) await checkAlias276(async () => {
        const f = await fixture(1, 'noop', prefix + aliasSuffix276), state = await make(f);
        state.ownerProjects.push({ attachments: [{ kind: 'file', uri: f.plan[0].attachment.uri.replace(prefix, otherPrefix) }] });
        assert.deepEqual(invoke(state, input(f)), { value: { outcome: 'removed' }, seen: ['retire'] }, 'only the complete fixed /var/ prefix has a sibling');
    });
    console.log(`Task276: ${aliasCases276} v1 Save alias-reference checks (real254 pure envelopes; no physical normalization)`);
    await check(async () => {
        const state = await make(), seen = [];
        const callback = () => { seen.push('callback'); return '{"outcome":"removed"}'; };
        assert.throws(() => state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: 2,
            envelopeJSON: JSON.stringify(plain.envelope), candidateIndex: 0, currentURI: 'file:///var/current.pdf' }),
        callback, callback, callback), /INVALID_INPUT: Invalid attachment Save handoff/);
        assert.deepEqual(seen, [], 'v2 cannot borrow a validated legacy file-only envelope');
    });
    for (const change of ['missing', 'rev', 'revBy', 'updatedAt']) await check(async () => {
        const state = await make();
        if (change === 'missing') state.ownerTaskMap = new Map();
        else state.ownerTaskMap = new Map([['task259', { ...plain.after, [change]: change === 'rev' ? 9 : 'changed' }]]);
        assert.deepEqual(invoke(state), { value: { outcome: 'taskChanged' }, seen: ['taskChanged'] });
    });
    await check(async () => {
        const state = await make(); state.ownerTaskMap = new Map();
        state.ownerProjects = [{ attachments: [{ kind: 'file', uri: plain.plan[0].attachment.uri }] }];
        assert.deepEqual(invoke(state), { value: { outcome: 'referenced' }, seen: ['referenced'] }, 'live reference wins moved-task reason');
    });
    await check(async () => {
        const owned = plain.envelope.request.ownedDraft;
        const added = await poll(fixtureState, fixtureState.MindwtrHost.attachmentDraftPrepareV3(JSON.stringify({ ...owned,
            requestId: '25900000-0000-4000-8000-000000000003', picked: { uri: 'file:///library/cache/picked.pdf',
                name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 })));
        assert.equal(added.ok, true); assert.equal(added.value.kind, 'prepared');
        const withAdd = { ...owned, beforePayloadJSON: added.value.afterPayloadJSON,
            priorOperations: [...owned.priorOperations, { kind: 'add', operation: added.value }] };
        const removed = await poll(fixtureState, fixtureState.MindwtrHost.attachmentDraftRemovePrepareV3(JSON.stringify({ ...withAdd,
            requestId: '25900000-0000-4000-8000-000000000004', attachmentId: added.value.requestId })));
        assert.equal(removed.ok, true);
        const envelope = JSON.parse(JSON.stringify(plain.envelope)), request = envelope.request;
        request.checkpoint = { ...request.checkpoint, generation: 4, payloadJSON: removed.value.afterPayloadJSON };
        request.ownedDraft = { ...withAdd, beforePayloadJSON: removed.value.afterPayloadJSON,
            priorOperations: [...withAdd.priorOperations, { kind: 'remove', operation: removed.value }] };
        request.saveRequest.attachments.value = JSON.parse(removed.value.afterPayloadJSON).attachments;
        const after = { ...plain.after, attachments: request.saveRequest.attachments.value };
        envelope.prepared.request = request;
        envelope.prepared.decision.effect.task = { before: after, after };
        const validation = await poll(fixtureState, fixtureState.MindwtrHost.attachmentFileEditSaveValidate(JSON.stringify(envelope)));
        assert.equal(validation.ok, true, 'real254 validates mixed Remove/Add/Remove file-only noop');
        const f = { envelope, after, plan: validation.value.settlementPlan }, index = f.plan.findIndex((value) => value.reason === 'uncommitted-draft');
        assert(index >= 0);
        const state = await make(f); state.ownerTaskMap = new Map();
        assert.deepEqual(invoke(state, input(f, index)), { value: { outcome: 'removed' }, seen: ['retire'] }, 'new draft copy ignores moved-task fence');
        assert.throws(() => invoke(state, input(f, index), 'generationChanged'), /INVALID_INPUT: Invalid attachment Save handoff/);
    });
    await check(async () => {
        const state = await make(); let release;
        state.backupPrepareHold = new Promise((resolveHeld) => { release = resolveHeld; });
        const ticket = state.MindwtrHost.backupDocumentPrepare('{}');
        assert.throws(() => invoke(state), /NOT_READY: Attachment Save requires settled native storage/);
        release(); await new Promise((resolveTick) => setImmediate(resolveTick));
        assert.deepEqual(invoke(state), { value: { outcome: 'removed' }, seen: ['retire'] }, 'done unpolled slot is settled');
        assert.equal((await poll(state, ticket)).ok, true);
    });
    for (const field of ['queued', 'inFlight', 'immediate', 'retrying', 'failed']) await check(async () => {
        const state = await make(); state.persistenceStatus = { ...state.persistenceStatus, [field]: true };
        assert.throws(() => invoke(state), /NOT_READY: Attachment Save requires settled native storage/);
    });
    for (const kind of ['beforeBoot', 'nonIOS', 'noCapability', 'sandbox', 'transition', 'loading', 'failure', 'editLock', 'adapter']) await check(async () => {
        let state;
        if (kind === 'beforeBoot') state = makeState(0, [], 'ios', configureLocal);
        else if (kind === 'nonIOS') state = await make(plain, configureLocal, 'android');
        else if (kind === 'noCapability') state = await make(plain, (value) => { value.realMixedSaveValidation = true; });
        else state = await make();
        if (kind === 'sandbox') state.sandbox = true;
        if (kind === 'transition') state.workspaceTransition = true;
        if (kind === 'loading') state.storeLoading = true;
        if (kind === 'failure') state.persistenceFailure = { private: 'secret' };
        if (kind === 'editLock') state.storeEditLocks = 1;
        if (kind === 'adapter') state.adapter = {};
        assert.throws(() => invoke(state), /NOT_READY: Attachment Save requires settled native storage/);
    });
    for (const field of ['tasks', 'projects', 'map', 'generation', 'queued', 'sandbox', 'adapter']) await check(async () => {
        const state = await make();
        const row = { id: 'inert' };
        Object.defineProperty(row, 'attachments', { get() {
            if (field === 'tasks') state.lastLoaded.tasks = [...state.lastLoaded.tasks];
            if (field === 'projects') state.ownerProjects = [];
            if (field === 'map') state.ownerTaskMap = new Map(state.ownerTaskMap);
            if (field === 'generation') state.persistenceStatus.generation++;
            if (field === 'queued') state.persistenceStatus.queued = true;
            if (field === 'sandbox') state.sandbox = true;
            if (field === 'adapter') state.adapter = {};
            return [];
        } });
        state.lastLoaded.tasks.push(row);
        assert.throws(() => invoke(state), /NOT_READY: Attachment Save requires settled native storage/);
    });
    const invalid = 'INVALID_INPUT: Invalid attachment Save handoff';
    const awaitReady259 = await make();
    for (const value of [null, [], {}, { version: 2, envelopeJSON: '{}', candidateIndex: 0 },
        { version: 1, envelopeJSON: 3, candidateIndex: 0 }, { version: 1, envelopeJSON: '{}', candidateIndex: 0, permission: true },
        ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, true, null, 1].map((candidateIndex) => ({ version: 1, envelopeJSON: JSON.stringify(plain.envelope), candidateIndex }))]) await check(async () => {
        assert.throws(() => invoke(awaitReady259, JSON.stringify(value)), { message: invalid });
    });
    for (const json of ['{private-draft', JSON.stringify({ version: 1, envelopeJSON: '{secret', candidateIndex: 0 }),
        'x'.repeat(8 * 1024 * 1024 + 1), JSON.stringify({ version: 1, envelopeJSON: '界'.repeat(3 * 1024 * 1024), candidateIndex: 0 })]) await check(async () => {
        assert.throws(() => invoke(awaitReady259, json), { message: invalid });
    });
    await check(async () => {
        const forged = JSON.parse(JSON.stringify(plain.envelope)); forged.prepared.decision.effect.task.after.rev++;
        assert.throws(() => invoke(awaitReady259, JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(forged), candidateIndex: 0 })), { message: invalid });
    });
    for (const field of ['session', 'request']) await check(async () => {
        const forged = JSON.parse(JSON.stringify(plain.envelope));
        if (field === 'session') forged.request.checkpoint.sessionID += '\n';
        else forged.request.ownedDraft.priorOperations[0].operation.requestId += '\n';
        forged.prepared.request = forged.request;
        assert.throws(() => invoke(awaitReady259, JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(forged), candidateIndex: 0 })), { message: invalid });
    });
    for (const reply of ['!MindwtrNativeError:secret-content', '{private-content', '{}', '{"outcome":"referenced"}',
        '{"outcome":"removed","extra":"secret"}', '界'.repeat(400), Promise.resolve('{"outcome":"removed"}')]) await check(async () => {
        const seen = [];
        assert.throws(() => awaitReady259.MindwtrHost.attachmentFileEditSaveRetire(input(), () => { seen.push('keep'); return '{}'; },
            () => { seen.push('moved'); return '{}'; }, () => { seen.push('retire'); return reply; }), { message: invalid });
        assert.deepEqual(seen, ['retire'], 'malformed acknowledgment never retries another callback');
    });
    await check(async () => {
        const seen = [];
        assert.throws(() => awaitReady259.MindwtrHost.attachmentFileEditSaveRetire(input(), () => '{}', () => '{}', () => {
            seen.push('retire'); throw Error('private content/path');
        }), { message: 'NOT_READY: Attachment Save requires settled native storage' });
        assert.deepEqual(seen, ['retire']);
    });
    await check(async () => {
        for (const callbacks of [[null, () => '{}', () => '{}'], [() => '{}', null, () => '{}'], [() => '{}', () => '{}', null]]) {
            assert.throws(() => awaitReady259.MindwtrHost.attachmentFileEditSaveRetire(input(), ...callbacks), { message: invalid });
        }
    });
    await check(async () => {
        const state = await make(); state.order259 = []; state.input259 = input();
        state.keep259 = () => { throw Error('wrong branch'); };
        state.retire259 = () => { state.order259.push('retire'); return '{"outcome":"absent"}'; };
        vm.runInNewContext(`Promise.resolve().then(() => order259.push('microtask'));
            globalThis.direct259 = MindwtrHost.attachmentFileEditSaveRetire(input259, keep259, keep259, retire259);
            order259.push('returned');`, state);
        assert.deepEqual(state.order259, ['retire', 'returned']);
        await new Promise((resolveTick) => setImmediate(resolveTick));
        assert.deepEqual(state.order259, ['retire', 'returned', 'microtask']);
        assert.equal(state.direct259, '{"outcome":"absent"}');
    });
    await check(async () => {
        const state = await make();
        const before = JSON.stringify({ events: state.events, data: state.fakeData, files: state.fileCalls, logOps: state.logOps });
        invoke(state);
        assert.equal(JSON.stringify({ events: state.events, data: state.fakeData, files: state.fileCalls, logOps: state.logOps }), before,
            'unbound fence performs no native file/flush/store/diagnostic work');
        assert.equal((await poll(state, state.MindwtrHost.attachmentRequest('attachmentFileEditSaveRetire', '{}'))).ok, false);
    });
    console.log(`Task259: ${cases} synchronous mixed Save fence checks (real254 file-only pure validation + shared references/revision; NodeVM only)`);
}
// Task268: the real bound complete factory prepares/commits against SQLite;
// the existing VM bridge still owns platform dispatch and same-turn callbacks.
{
    const { DatabaseSync } = await import('node:sqlite');
    const AT = '2026-10-05T10:00:00.000Z', ROOT = 'file:///library/documents/attachments/';
    const SESSION = '26800000-0000-4000-8000-000000000001', REQUEST = '26800000-0000-4000-8000-000000000002';
    const configureLocal = (state) => {
        state.localAttachmentTest = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null; state.__mindwtrInstallerCall = async () => null;
    };
    const databases = []; let cases = 0;
    const check = async (work) => { await work(); cases++; };
    const call = (state, method, input) => poll(state, state.MindwtrHost[method](JSON.stringify(input)));
    const fixture = async ({ empty = false, noop = false, recurring = false, cancel = false, large = false, withAdd = false, availability = false, availabilityTombstone = false, availabilitySameURI = false,
        managedDirectoryURI = ROOT } = {}) => {
        const baseline = Array.from({ length: 2 }, (_, n) => ({ id: `file${n}`, kind: 'file', title: 'File', uri: managedDirectoryURI + `${n}.pdf`,
            size: 3, localStatus: 'available', createdAt: AT, updatedAt: AT }));
        if (availability) Object.assign(baseline[0], { uri: availabilitySameURI ? managedDirectoryURI + '0.pdf' : '', cloudKey: 'attachments/file0.pdf', fileHash: 'a'.repeat(64), localStatus: 'missing' });
        baseline.push({ ...baseline[0], id: 'old-tombstone', uri: managedDirectoryURI + 'old.pdf', deletedAt: AT });
        const source = { id: 'task268', title: 'Task', status: 'next', taskMode: 'list', tags: [], contexts: [], checklist: [],
            description: large ? 'x'.repeat(270_000) : 'Notes', attachments: baseline, createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before',
            ...(recurring ? { dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' } } : {}) };
        const data = { tasks: [source], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device268' } };
        const db = new DatabaseSync(':memory:'); databases.push(db);
        const state = makeState('auto', [], 'ios', (value) => {
            configureLocal(value); value.fakeData = JSON.parse(JSON.stringify(data)); value.completeSeed = data;
            value.completeSqliteClient = { run: async (sql, params = []) => { db.prepare(sql).run(...params); },
                all: async (sql, params = []) => db.prepare(sql).all(...params),
                get: async (sql, params = []) => db.prepare(sql).all(...params)[0], exec: async (sql) => { db.exec(sql); } };
            value.realMixedSaveValidation = true;
        });
        assert.equal((await poll(state, state.MindwtrHost.boot())).ok, true);
        const edited = recurring ? { status: 'done', completedAt: '', focusedToday: false } : noop || cancel ? {} : { title: 'Edited' };
        const touchedBase = Object.fromEntries(Object.keys(edited).map((field) => [field, field === 'status' ? 'next' : field === 'focusedToday' ? false : field === 'title' ? 'Task' : '']));
        const initialPayloadJSON = JSON.stringify({ version: 2, taskID: source.id, tab: 'task', touchedBase, edited,
            raw: { title: edited.title ?? '', note: '', location: '', estimate: '', estimateResolved: '', timeSpent: '', timeSpentResolved: '',
                tokens: {}, tokenCanonical: {}, tokenResolved: {}, tokenEdited: [], checklistInputs: {}, checklistAppend: '',
                relativeAmount: '', relativeUnit: '', relativeOwned: false, relativeCommitRequested: false,
                recurrenceInputs: {}, recurrenceOwned: [], recurrenceCommitRequested: [] }, scheduleEdits: [], scheduleFailedID: null,
            attachmentsOwned: true, attachmentsBase: baseline, attachments: baseline, linkSheet: {} });
        const ownedDraft = { version: availability ? 5 : 3, taskID: source.id, initialPayloadJSON, beforePayloadJSON: initialPayloadJSON,
            priorOperations: [], managedDirectoryURI };
        if (!empty && !availability) for (let index = 0; index < (recurring || cancel ? 1 : 2); index++) {
            const removed = await call(state, 'attachmentDraftRemovePrepareV3', { ...ownedDraft,
                requestId: `26800000-0000-4000-8000-${String(index + 3).padStart(12, '0')}`, attachmentId: `file${index}` });
            assert.equal(removed.ok, true); ownedDraft.beforePayloadJSON = removed.value.afterPayloadJSON;
            ownedDraft.priorOperations.push({ kind: 'remove', operation: removed.value });
        }
        if (withAdd) {
            const added = await call(state, 'attachmentDraftPrepareV3', { ...ownedDraft,
                requestId: '27600000-0000-4000-8000-000000000003', measuredSize: 3,
                picked: { uri: 'file:///library/cache/picked.pdf', name: 'Picked.pdf', mimeType: null, size: null } });
            assert.equal(added.ok, true); assert.equal(added.value.kind, 'prepared');
            ownedDraft.beforePayloadJSON = added.value.afterPayloadJSON;
            ownedDraft.priorOperations.push({ kind: 'add', operation: added.value });
        }
        if (availability) {
            const resolved = { ...baseline[0], uri: managedDirectoryURI + '0.pdf', localStatus: 'available' };
            const afterPayloadJSON = JSON.stringify({ ...JSON.parse(initialPayloadJSON), attachments: [resolved, ...baseline.slice(1)] });
            ownedDraft.priorOperations.push({ kind: 'availability', operation: { version: 1, kind: 'prepared-file-availability',
                taskID: source.id, requestId: '35600000-0000-4000-8000-000000000002', attachmentId: baseline[0].id,
                identity: JSON.stringify([baseline[0].id, baseline[0].cloudKey, baseline[0].fileHash, 0]),
                beforePayloadJSON: initialPayloadJSON, afterPayloadJSON, status: 'available', resolvedAttachmentJSON: JSON.stringify(resolved) } });
            ownedDraft.beforePayloadJSON = afterPayloadJSON;
        }
        const draft = JSON.parse(ownedDraft.beforePayloadJSON).attachments;
        if (noop && !empty) source.attachments = draft;
        if (availabilityTombstone) source.attachments = baseline.map((row, index) => index === 0
            ? { ...row, deletedAt: '2026-10-06T00:00:00.000Z' } : row);
        const request = { version: availability ? 4 : 2, kind: 'owned-editor-file-edit-save',
            checkpoint: { version: 1, sessionID: SESSION, taskID: source.id, generation: ownedDraft.priorOperations.length + 1, payloadJSON: ownedDraft.beforePayloadJSON },
            ownedDraft, saveRequest: { id: source.id, requestId: REQUEST, base: touchedBase, patch: edited,
                scheduleBase: { startTime: null, dueDate: recurring ? '2026-10-05' : null, relativeStartOffset: null, reviewAt: null },
                checklist: { base: [], value: [] }, attachments: { base: baseline, value: draft }, ...(cancel ? { intent: 'cancel' } : {}) } };
        const prepared = await call(state, 'attachmentFileEditSavePrepare', request);
        assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.value.kind, 'prepared');
        const envelope = { request, prepared: prepared.value.prepared };
        const checked = await call(state, 'attachmentFileEditSaveValidate', envelope); assert.equal(checked.ok, true);
        const after = envelope.prepared.decision.kind === 'changed'
            ? envelope.prepared.decision.prepared.effect.tasks.find((row) => row.after.id === source.id).after
            : envelope.prepared.decision.prepared.witness.source;
        return { state, db, request, envelope, after, plan: checked.value.settlementPlan };
    };
    const syncLive = (f) => {
        f.state.lastLoaded.tasks = f.db.prepare('SELECT id, rev, revBy, updatedAt, attachments FROM tasks ORDER BY id').all()
            .map((row) => ({ ...row, attachments: JSON.parse(row.attachments ?? '[]') }));
        f.state.ownerTaskMap = new Map(f.state.lastLoaded.tasks.map((row) => [row.id, row]));
    };
    const invoke = (f, index = 0, envelopeJSON = JSON.stringify(f.envelope), currentURI) => {
        const seen = [], callback = (outcome) => function () { assert.equal(arguments.length, 0); seen.push(outcome); return JSON.stringify({ outcome }); };
        const result = f.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: currentURI === undefined ? 1 : 2,
            envelopeJSON, candidateIndex: index, ...(currentURI === undefined ? {} : { currentURI }) }),
            callback('referenced'), callback('taskChanged'), callback('removed'));
        return { result: JSON.parse(result), seen };
    };
    try {
        for (const options of [{ empty: true }, { empty: true, noop: true }, { noop: true }, {}]) await check(async () => {
            const f = await fixture(options); assert.equal(f.envelope.prepared.version, 2);
            assert.equal(f.envelope.prepared.decision.kind, options.noop ? 'noop' : 'changed');
            if (options.empty) assert.equal(f.plan.length, 0, 'empty history protects even old baseline tombstones');
            const committed = await call(f.state, 'attachmentFileEditSaveCommit', f.envelope); assert.equal(committed.ok, true);
            assert.equal(f.state.fileEditSaveInputs.at(-1)[0], 'completeCommit'); syncLive(f);
            if (!options.empty) assert.deepEqual(invoke(f), { result: { outcome: 'removed' }, seen: ['removed'] });
            if (options.empty && options.noop) assert.equal(f.db.prepare('SELECT rev FROM tasks WHERE id = ?').get('task268').rev, 8);
        });
        await check(async () => {
            const f = await fixture({ availability: true });
            assert.equal(f.envelope.prepared.version, 4);
            assert.equal(JSON.parse(f.db.prepare('SELECT attachments FROM tasks WHERE id = ?').get('task268').attachments)[0].uri, '',
                'selected download proof and Save preparation leave stored Task unchanged');
            const resumed = await call(f.state, 'attachmentDraftResumeCheckV3', { version: 3, kind: 'owned-editor-resume',
                checkpoint: f.request.checkpoint, ownedDraft: f.request.ownedDraft });
            assert.equal(resumed.ok, true, JSON.stringify(resumed));
            assert.equal((await call(f.state, 'attachmentFileEditSaveCommit', f.envelope)).ok, true);
            syncLive(f);
            const row = f.db.prepare('SELECT title, attachments FROM tasks WHERE id = ?').get('task268');
            assert.equal(row.title, 'Edited'); assert.equal(JSON.parse(row.attachments)[0].uri, ROOT + '0.pdf');
            assert.equal(f.state.fileEditSaveInputs.at(-1)[0], 'completeCommit');
            assert(f.plan.length > 0);
            assert.deepEqual(invoke(f), { result: { outcome: 'removed' }, seen: ['removed'] },
                'outer4 uses complete result classification at the existing retirement fence');
        });
        await check(async () => {
            const f = await fixture({ availability: true, cancel: true });
            assert.equal((await call(f.state, 'attachmentFileEditSaveCommit', f.envelope)).ok, true);
            const request = { requestId: '35600000-0000-4000-8000-000000000099', cancelRequestId: REQUEST };
            const prepared = await call(f.state, 'taskCancellationUndoPrepare', { request, cancel: f.envelope });
            assert.equal(prepared.ok, true, JSON.stringify(prepared));
            assert.equal(f.state.fileEditSaveInputs.at(-1)[0], 'completeUndoPrepare');
            assert.equal((await call(f.state, 'taskCancellationUndoCommit', { request, prepared: prepared.value.prepared })).ok, true);
            const row = f.db.prepare('SELECT status, attachments FROM tasks WHERE id = ?').get('task268');
            assert.equal(row.status, 'next'); assert.equal(JSON.parse(row.attachments)[0].uri, ROOT + '0.pdf');
        });
        await check(async () => {
            const f = await fixture({ availability: true, availabilityTombstone: true });
            assert.equal((await call(f.state, 'attachmentFileEditSaveCommit', f.envelope)).ok, true); syncLive(f);
            const index = f.plan.findIndex((row) => row.reason === 'uncommitted-draft' && row.attachment.uri === ROOT + '0.pdf');
            assert(index >= 0, 'new available URI survives as an uncommitted candidate when a concurrent tombstone wins');
            const input = JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(f.envelope), candidateIndex: index });
            let borrowed = 0;
            const keep = () => '{"outcome":"referenced"}', changed = () => { throw Error('wrong branch'); };
            const retire = () => { borrowed++; return '{"outcome":"notOwned"}'; };
            assert.equal(f.state.MindwtrHost.attachmentFileEditSaveRetire(input, keep, changed, retire), '{"outcome":"notOwned"}');
            assert.equal(borrowed, 1);
            assert.equal(f.state.MindwtrHost.attachmentFileEditSaveRetire(input, changed, changed, keep), '{"outcome":"referenced"}', 'selected native durable-reference backstop can retain bytes');
            f.state.ownerProjects = [{ attachments: [{ kind: 'file', uri: ROOT + '0.pdf' }] }];
            assert.equal(f.state.MindwtrHost.attachmentFileEditSaveRetire(input, keep, changed, retire), '{"outcome":"referenced"}');
            assert.equal(borrowed, 1, 'fresh references keep the file even on a cached selected plan');
            f.state.ownerProjects = [];
            const same = await fixture({ availability: true, availabilityTombstone: true, availabilitySameURI: true });
            assert.equal((await call(same.state, 'attachmentFileEditSaveCommit', same.envelope)).ok, true); syncLive(same);
            const baseline = same.plan.findIndex((row) => row.reason === 'deleted-after-save' && row.attachment.uri === ROOT + '0.pdf');
            assert(baseline >= 0, 'same-URI borrowed availability can become a baseline cleanup candidate');
            assert.equal(same.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: 1,
                envelopeJSON: JSON.stringify(same.envelope), candidateIndex: baseline }), keep, changed, retire), '{"outcome":"notOwned"}');
            const historical = await fixture();
            assert.equal((await call(historical.state, 'attachmentFileEditSaveCommit', historical.envelope)).ok, true); syncLive(historical);
            assert.throws(() => historical.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: 1,
                envelopeJSON: JSON.stringify(historical.envelope), candidateIndex: 0 }), keep, changed, retire), /INVALID_INPUT/);
        });
        const recurring = await fixture({ recurring: true });
        await check(async () => {
            assert.equal((await call(recurring.state, 'attachmentFileEditSaveCommit', recurring.envelope)).ok, true); syncLive(recurring);
            const child = recurring.state.lastLoaded.tasks.find((row) => row.id !== 'task268'); assert(child);
            assert(child.attachments.some((row) => row.uri === ROOT + '0.pdf' && !row.deletedAt));
            const index = recurring.plan.findIndex((row) => row.attachment.uri === ROOT + '0.pdf'); assert(index >= 0);
            assert.deepEqual(invoke(recurring, index), { result: { outcome: 'referenced' }, seen: ['referenced'] }, 'fresh generated child keeps the source tombstone bytes');
        });
        const reusable = await fixture(); assert.equal((await call(reusable.state, 'attachmentFileEditSaveCommit', reusable.envelope)).ok, true); syncLive(reusable);
        const validations = () => reusable.state.fileEditSaveInputs.filter(([name]) => name === 'completeValidate').length;
        const first = reusable.plan.findIndex((row) => row.attachment.id === 'file0'), second = reusable.plan.findIndex((row) => row.attachment.id === 'file1');
        assert(first >= 0 && second >= 0 && second < reusable.plan.length - 1);
        await check(async () => {
            const before = validations(); invoke(reusable, first); reusable.state.ownerProjects = [{ attachments: [{ kind: 'file', uri: ROOT + '1.pdf' }] }];
            assert.deepEqual(invoke(reusable, second), { result: { outcome: 'referenced' }, seen: ['referenced'] });
            reusable.state.ownerProjects = []; reusable.state.ownerTaskMap = new Map([['task268', { ...reusable.after, rev: reusable.after.rev + 1 }]]);
            assert.deepEqual(invoke(reusable, second), { result: { outcome: 'taskChanged' }, seen: ['taskChanged'] }); syncLive(reusable);
            assert.equal(validations() - before, 1, 'exact complete plan hits retain fresh project refs and current revision');
        });
        await check(async () => {
            const before = validations(), raw = JSON.stringify(reusable.envelope);
            for (const text of [` ${raw}\n`, raw.replaceAll('task268', 't\\u0061sk268'), raw]) invoke(reusable, first, text);
            assert.equal(validations() - before, 3, 'raw whitespace and Unicode spelling do not share authority');
            reusable.state.persistenceStatus = { generation: 0, queued: true };
            assert.throws(() => invoke(reusable, second), /NOT_READY/); reusable.state.persistenceStatus.queued = false;
            const row = { id: 'inert' }; Object.defineProperty(row, 'attachments', { get() { reusable.state.persistenceStatus.generation++; return []; } });
            reusable.state.lastLoaded.tasks.push(row); assert.throws(() => invoke(reusable, second), /NOT_READY/); syncLive(reusable);
        });
        await check(async () => {
            const historical = makeState(0, [], 'ios'); historical.sandbox = true; historical.workspaceTransition = true;
            assert.equal((await call(historical, 'attachmentFileEditSaveValidate', reusable.envelope)).ok, true);
            for (const version of [0, 3, null]) {
                const wrong = JSON.parse(JSON.stringify(reusable.envelope)); wrong.request.version = version;
                assert.equal((await call(historical, 'attachmentFileEditSaveValidate', wrong)).ok, false);
            }
            for (const field of ['request', 'prepared']) {
                const wrong = JSON.parse(JSON.stringify(reusable.envelope)); wrong[field].version = 1;
                assert.equal((await call(historical, 'attachmentFileEditSaveValidate', wrong)).ok, false);
                assert.equal((await call(reusable.state, 'attachmentFileEditSaveCommit', wrong)).ok, false);
            }
            const old = JSON.parse(JSON.stringify(reusable.envelope)); old.request.version = 1; old.prepared.version = 1; old.prepared.request = old.request;
            assert.equal((await call(reusable.state, 'attachmentFileEditSaveValidate', old)).ok, false, 'old factory rejects the selected inner grammar');
            const android = makeState(0, [], 'android', configureLocal);
            for (const method of ['attachmentFileEditSavePrepare', 'attachmentFileEditSaveValidate', 'attachmentFileEditSaveCommit'])
                assert.equal((await call(android, method, method.endsWith('Prepare') ? reusable.request : reusable.envelope)).ok, false);
            assert.equal((await poll(reusable.state, reusable.state.MindwtrHost.attachmentRequest('attachmentFileEditSavePrepare', JSON.stringify(reusable.request)))).ok, false);
        });
        const cancel = await fixture({ cancel: true, large: true });
        await check(async () => {
            const result = await call(cancel.state, 'attachmentFileEditSaveCommit', cancel.envelope); assert.equal(result.ok, true); assert(result.value.cancellation);
            const attachments = JSON.parse(cancel.db.prepare('SELECT attachments FROM tasks WHERE id = ?').get('task268').attachments);
            attachments.push({ ...attachments[0], id: 'later', uri: ROOT + 'later.pdf', deletedAt: undefined });
            cancel.db.prepare('UPDATE tasks SET title = ?, attachments = ?, rev = rev + 1 WHERE id = ?').run('Later title', JSON.stringify(attachments), 'task268');
            const request = { requestId: '26800000-0000-4000-8000-000000000099', cancelRequestId: REQUEST };
            const cold = makeState(0, [], 'ios', (value) => { value.completeSqliteClient = cancel.state.completeSqliteClient; });
            assert.equal((await poll(cold, cold.MindwtrHost.boot())).ok, true);
            const prepared = await call(cold, 'taskCancellationUndoPrepare', { request, cancel: cancel.envelope }); assert.equal(prepared.ok, true, JSON.stringify(prepared));
            const undo = { request, prepared: prepared.value.prepared }, bytes = Buffer.byteLength(JSON.stringify(undo));
            assert(bytes > 2_000_000 && bytes < 8 * 1024 * 1024, 'selected Undo crosses the old editor bound but stays attachment-bounded');
            const historical = makeState(0, [], 'ios');
            assert.equal((await call(historical, 'taskCancellationUndoValidate', undo)).ok, true);
            assert.equal((await call(cold, 'taskCancellationUndoCommit', undo)).ok, true, 'cold metadata Undo needs no current local attachment capability');
            const row = cancel.db.prepare('SELECT title, status, attachments FROM tasks WHERE id = ?').get('task268');
            assert.equal(row.title, 'Later title'); assert.equal(row.status, 'next'); assert(JSON.parse(row.attachments).some((entry) => entry.id === 'later'));
            for (const mutate of [(value) => { value.prepared.cancel.request.saveRequest.requestId += '\n'; }, (value) => { value.prepared.version = 1; }]) {
                const wrong = JSON.parse(JSON.stringify(undo)); mutate(wrong); assert.equal((await call(historical, 'taskCancellationUndoValidate', wrong)).ok, false);
            }
            const android = makeState(0, [], 'android'); assert.equal((await call(android, 'taskCancellationUndoValidate', undo)).ok, false);
            assert.equal((await call(historical, 'taskCancellationUndoValidate', { request, prepared: { version: 1, kind: 'undo', oversized: 'x'.repeat(2_000_001) } })).ok, false,
                'legacy iOS Undo retains its ordinary editor bound');
        });
        await check(async () => {
            reusable.state.order268 = []; reusable.state.input268 = JSON.stringify({ version: 1, envelopeJSON: JSON.stringify(reusable.envelope), candidateIndex: first });
            reusable.state.keep268 = () => { throw Error('wrong branch'); }; reusable.state.retire268 = () => { reusable.state.order268.push('retire'); return '{"outcome":"absent"}'; };
            vm.runInNewContext(`Promise.resolve().then(() => order268.push('microtask'));
                MindwtrHost.attachmentFileEditSaveRetire(input268, keep268, keep268, retire268); order268.push('returned');`, reusable.state);
            assert.deepEqual(reusable.state.order268, ['retire', 'returned']); await new Promise((done) => setImmediate(done));
            assert.deepEqual(reusable.state.order268, ['retire', 'returned', 'microtask']);
        });
        // Task276: current URI is fresh per call, never part of the immutable
        // complete plan memo. These callbacks test policy, not physical IO.
        let relocationCases276 = 0;
        const checkRelocation276 = async (work) => { await check(work); relocationCases276++; };
        const oldRoot276 = 'file:///private/var/mobile/Containers/Data/Application/27600000-0000-4000-8000-000000000001/Library/attachment-files/documents/attachments/';
        const relocated = await fixture({ managedDirectoryURI: oldRoot276 });
        assert.equal((await call(relocated.state, 'attachmentFileEditSaveCommit', relocated.envelope)).ok, true); syncLive(relocated);
        const index276 = relocated.plan.findIndex((entry) => entry.attachment.id === 'file0'); assert(index276 >= 0);
        const raw276 = JSON.stringify(relocated.envelope), original276 = relocated.plan[index276].attachment.uri;
        const current276 = original276.replace('file:///private/var/', 'file:///var/')
            .replace('Application/27600000-0000-4000-8000-000000000001/', 'Application/27600000-0000-4000-8000-000000000002/');
        const refs276 = [original276, original276.replace('file:///private/var/', 'file:///var/'), current276,
            current276.replace('file:///var/', 'file:///private/var/')];
        const reset276 = () => { syncLive(relocated); relocated.state.ownerProjects = []; relocated.state.persistenceStatus = { generation: 0 }; };
        for (const where of ['task', 'project']) for (const uri of refs276) await checkRelocation276(async () => {
            reset276(); const owner = { id: 'live-alias-ref', attachments: [{ kind: 'file', uri }] };
            (where === 'task' ? relocated.state.lastLoaded.tasks : relocated.state.ownerProjects).push(owner);
            assert.deepEqual(invoke(relocated, index276, raw276, current276), { result: { outcome: 'referenced' }, seen: ['referenced'] });
        });
        await checkRelocation276(async () => {
            reset276(); relocated.state.ownerProjects = [{ deletedAt: AT, attachments: [{ kind: 'file', uri: current276 }] },
                { attachments: [{ kind: 'file', uri: refs276[3], deletedAt: AT }] }];
            assert.deepEqual(invoke(relocated, index276, raw276, current276), { result: { outcome: 'removed' }, seen: ['removed'] });
            relocated.state.ownerTaskMap = new Map();
            assert.deepEqual(invoke(relocated, index276, raw276, current276), { result: { outcome: 'taskChanged' }, seen: ['taskChanged'] });
            relocated.state.ownerProjects.push({ attachments: [{ kind: 'file', uri: refs276[3] }] });
            assert.deepEqual(invoke(relocated, index276, raw276, current276), { result: { outcome: 'referenced' }, seen: ['referenced'] },
                'current alias reference wins over a moved source');
        });
        await checkRelocation276(async () => {
            reset276(); const before = relocated.state.fileEditSaveInputs.filter(([name]) => name === 'completeValidate').length;
            assert.deepEqual(invoke(relocated, index276, raw276, current276), { result: { outcome: 'removed' }, seen: ['removed'] });
            const laterURI = current276.replace('/0.pdf', '/later.pdf');
            relocated.state.ownerProjects.push({ attachments: [{ kind: 'file', uri: laterURI }] });
            assert.deepEqual(invoke(relocated, index276, raw276, laterURI), { result: { outcome: 'referenced' }, seen: ['referenced'] });
            assert.equal(relocated.state.fileEditSaveInputs.filter(([name]) => name === 'completeValidate').length, before,
                'memo hits retain neither current URI nor reference outcome');
            relocated.state.persistenceStatus.queued = true;
            assert.throws(() => invoke(relocated, index276, raw276, laterURI), /NOT_READY/);
        });
        await checkRelocation276(async () => {
            reset276(); let reads = 0, entered = 0; const owner = {};
            Object.defineProperty(owner, 'attachments', { get() {
                if (++reads === 4) relocated.state.persistenceStatus.generation++;
                return [{ kind: 'file', uri: refs276[3] }];
            } });
            relocated.state.ownerProjects.push(owner);
            const callback = () => { entered++; return '{"outcome":"referenced"}'; };
            assert.throws(() => relocated.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: 2,
                envelopeJSON: raw276, candidateIndex: index276, currentURI: current276 }), callback, callback, callback), /NOT_READY/);
            assert(reads >= 4, 'old/current and both alias spellings share the same generation fence'); assert.equal(entered, 0);
        });
        await checkRelocation276(async () => {
            reset276(); const valid = { version: 2, envelopeJSON: raw276, candidateIndex: index276, currentURI: current276 };
            const invalid = 'INVALID_INPUT: Invalid attachment Save handoff';
            const frames = [
                ...[null, '', 'https://example.test/file', 'file://authority/file', 'file:///x?query', 'file:///x#fragment',
                    'file:///x//leaf', 'file:///x/../leaf', 'file:///x/%2e%2e/leaf', 'file:///x%2Fleaf', 'file:///x%5cleaf',
                    'file:///x/%00', 'file:///x/\u0000', 'file:///x/%', 'file:///' + '界'.repeat(5462)]
                    .map((currentURI) => ({ ...valid, currentURI })),
                ...[0, 3, null].map((version) => ({ ...valid, version })), { ...valid, version: 1 },
                { version: 2, envelopeJSON: raw276, candidateIndex: index276 }, { ...valid, proof: true },
                ...[-1, 0.5, true, relocated.plan.length].map((candidateIndex) => ({ ...valid, candidateIndex })),
                { ...valid, envelopeJSON: ' '.repeat(8 * 1024 * 1024) + raw276 },
            ];
            for (const frame of frames) {
                let entered = 0; const callback = () => { entered++; return '{"outcome":"removed"}'; };
                assert.throws(() => relocated.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify(frame), callback, callback, callback),
                    (error) => error.message === invalid); assert.equal(entered, 0, 'bad v2 fields refuse even on a memo hit');
            }
        });
        await checkRelocation276(async () => {
            const mixed = await fixture({ withAdd: true });
            assert.equal((await call(mixed.state, 'attachmentFileEditSaveCommit', mixed.envelope)).ok, true); syncLive(mixed);
            let entered = 0; const callback = () => { entered++; return '{"outcome":"removed"}'; };
            assert.throws(() => mixed.state.MindwtrHost.attachmentFileEditSaveRetire(JSON.stringify({ version: 2,
                envelopeJSON: JSON.stringify(mixed.envelope), candidateIndex: 0, currentURI: current276 }), callback, callback, callback),
            /INVALID_INPUT: Invalid attachment Save handoff/); assert.equal(entered, 0, 'a real complete Add/Remove envelope cannot borrow v2 cleanup');
        });
        console.log(`Task276: ${relocationCases276} v2 complete Remove-only reference/grammar checks (real266 SQLite envelope; same-turn callbacks only)`);
    } finally { for (const db of databases) db.close(); }
    console.log(`Task268: ${cases} complete Save/Undo/retire checks (real bound266 factory + SQLite, fresh refs and same-turn callbacks; Node VM)`);
}
// Task270: private iOS resume dispatch reaches the actual bound269 factory and raw SQLite reader.
{
    const { DatabaseSync } = await import('node:sqlite');
    const AT = '2026-10-05T10:00:00.000Z', ROOT = 'file:///library/documents/attachments/';
    const SESSION = '27000000-0000-4000-8000-000000000001';
    const databases = []; let cases = 0;
    const check = async (work) => { await work(); cases++; };
    const call = (state, method, input) => poll(state, state.MindwtrHost[method](JSON.stringify(input)));
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const fixture = async (mixed = false) => {
        const baseline = [{ id: 'file', kind: 'file', title: 'File', uri: ROOT + 'file.pdf', size: 3, localStatus: 'available', createdAt: AT, updatedAt: AT },
            { id: 'link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT }];
        const source = { id: 'task270', title: 'Opening', status: 'next', taskMode: 'list', tags: [], contexts: [],
            checklist: [{ id: 'row', title: 'Opening row', isCompleted: false }], description: 'Notes', attachments: baseline,
            createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before' };
        const data = { tasks: [source], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'existing270' } };
        const db = new DatabaseSync(':memory:'); databases.push(db); let writes = 0;
        const state = makeState('auto', [], 'ios', (value) => {
            value.resumeFixture = true; value.fakeData = clone(data); value.completeSeed = data;
            value.completeSqliteClient = {
                run: async (sql, params = []) => { db.prepare(sql).run(...params); if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes++; },
                all: async (sql, params = []) => db.prepare(sql).all(...params),
                get: async (sql, params = []) => db.prepare(sql).all(...params)[0], exec: async (sql) => { db.exec(sql); } };
        });
        assert.equal((await poll(state, state.MindwtrHost.boot())).ok, true);
        const initialPayloadJSON = JSON.stringify({ version: 2, taskID: source.id, tab: 'task', touchedBase: { title: 'Opening' }, edited: {},
            raw: { title: 'Unresolved title 🧪\n', estimate: '12.', timeSpent: '-', checklistInputs: { row: 'Unresolved row' }, checklistAppend: 'Pending row' },
            scheduleEdits: [{ id: 'pending', field: 'dueDate', value: '2026-10-10' }], scheduleFailedID: 'pending', checklistBase: source.checklist,
            attachmentsOwned: true, attachmentsBase: baseline, attachments: baseline, linkSheet: { text: 'https://[' } }, null, 2);
        const ownedDraft = { version: 3, taskID: source.id, initialPayloadJSON, beforePayloadJSON: initialPayloadJSON,
            priorOperations: [], managedDirectoryURI: ROOT };
        if (mixed) {
            // Actual shared producers validate the retained history; no file capability is installed in the resume VM.
            const producer = makeState(0, [], 'ios', (value) => {
                value.localAttachmentTest = true;
                for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) value.__mindwtrNative[name] = () => '';
                value.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
                value.__mindwtrFileCall = async () => null; value.__mindwtrInstallerCall = async () => null;
            });
            assert.equal((await poll(producer, producer.MindwtrHost.boot())).ok, true);
            const added = await call(producer, 'attachmentDraftPrepareV3', { ...ownedDraft,
                requestId: '27000000-0000-4000-8000-000000000010', picked: { uri: 'file:///cache/picked.pdf', name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 });
            assert.equal(added.ok, true); assert.equal(added.value.kind, 'prepared');
            ownedDraft.priorOperations.push({ kind: 'add', operation: added.value }); ownedDraft.beforePayloadJSON = added.value.afterPayloadJSON;
            const gap = JSON.parse(ownedDraft.beforePayloadJSON); gap.attachments.find((row) => row.id === 'link').title = 'Draft link title';
            ownedDraft.beforePayloadJSON = JSON.stringify(gap);
            const removed = await call(producer, 'attachmentDraftRemovePrepareV3', { ...ownedDraft,
                requestId: '27000000-0000-4000-8000-000000000011', attachmentId: 'file' });
            assert.equal(removed.ok, true); ownedDraft.priorOperations.push({ kind: 'remove', operation: removed.value });
            ownedDraft.beforePayloadJSON = removed.value.afterPayloadJSON;
        }
        const request = { version: 1, kind: 'owned-editor-resume', checkpoint: { version: 1, sessionID: SESSION, taskID: source.id,
            generation: ownedDraft.priorOperations.length + 1, payloadJSON: ownedDraft.beforePayloadJSON }, ownedDraft };
        // The existing lazy real-contract fixture activates before the read-only assertion baseline.
        assert.equal((await call(state, 'attachmentDraftResumeCheckV3', request)).ok, true);
        writes = 0; state.resumeReads = 0; state.resumeInputs.length = 0;
        return { state, db, request, source, writes: () => writes,
            rows: () => JSON.stringify([db.prepare('SELECT * FROM tasks ORDER BY id').all(), db.prepare('SELECT * FROM settings ORDER BY id').all()]) };
    };
    try {
        for (const mixed of [false, true]) await check(async () => {
            const f = await fixture(mixed), before = f.rows(), input = JSON.stringify(f.request), status = f.state.actualResumePersistence();
            const sideEffects = JSON.stringify([f.state.fileCalls, f.state.logOps, f.state.events]);
            const result = await call(f.state, 'attachmentDraftResumeCheckV3', f.request);
            assert.equal(result.ok, true); assert.equal(result.value.kind, 'ready');
            assert.equal(result.value.freshDraft.title, 'Opening'); assert.deepEqual(result.value.freshChecklistBase, f.source.checklist);
            assert.equal(typeof result.value.freshScheduleBase, 'object'); assert.equal(typeof result.value.freshRecurrenceBase, 'object');
            assert.deepEqual(result.value.freshAttachmentsBase, f.source.attachments);
            assert.equal(JSON.stringify(f.request), input); assert.equal(f.rows(), before); assert.equal(f.writes(), 0);
            assert.deepEqual(f.state.actualResumePersistence(), status); assert.equal(f.state.resumeReads, 1);
            assert.equal(JSON.stringify([f.state.fileCalls, f.state.logOps, f.state.events]), sideEffects, 'read emits no file work or success diagnostic');
            assert.equal(f.state.localShaInstallCount, 0, 'historical opening does not renew publication capability');
        });
        const f = await fixture(true);
        await check(async () => {
            const fresh = clone(f.source.attachments); fresh[0].cloudKey = 'concurrent'; fresh[0].deletedAt = AT;
            f.db.prepare('UPDATE tasks SET attachments = ?, description = ? WHERE id = ?').run(JSON.stringify(fresh), 'External note', f.source.id);
            const before = f.rows(), original = f.request.checkpoint.payloadJSON;
            const result = await call(f.state, 'attachmentDraftResumeCheckV3', f.request); assert.equal(result.ok, true);
            assert.deepEqual(result.value.freshAttachmentsBase, fresh); assert.equal(result.value.freshDraft.description, 'External note');
            assert.equal(f.request.checkpoint.payloadJSON, original); assert.equal(f.rows(), before); assert.equal(f.writes(), 0);
        });
        await check(async () => {
            f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Later title', f.source.id);
            const stale = await call(f.state, 'attachmentDraftResumeCheckV3', f.request); assert.equal(stale.ok, false); assert.match(stale.error, /STALE_REVISION/);
            f.db.prepare('INSERT INTO projects (id, title, status, color, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
                .run('archived270', 'Archived', 'archived', '#000000', AT, AT);
            f.db.prepare('UPDATE tasks SET title = ?, projectId = ? WHERE id = ?').run('Opening', 'archived270', f.source.id);
            const archived = await call(f.state, 'attachmentDraftResumeCheckV3', f.request); assert.equal(archived.ok, false); assert.match(archived.error, /INVALID_INPUT/);
            f.db.prepare('UPDATE tasks SET projectId = NULL WHERE id = ?').run(f.source.id);
            f.db.prepare('DELETE FROM projects WHERE id = ?').run('archived270'); assert.equal(f.writes(), 0);
        });
        await check(async () => {
            const reads = f.state.resumeReads;
            for (const mutate of [(value) => { value.version = 2; }, (value) => { value.ownedDraft.version = 2; },
                (value) => { value.checkpoint.generation = 1; }, (value) => { value.checkpoint.payloadJSON += ' '; },
                (value) => { value.checkpoint.taskID = 'foreign'; }, (value) => { value.touchedBase = { title: 'Caller base' }; }]) {
                const wrong = clone(f.request); mutate(wrong); const result = await call(f.state, 'attachmentDraftResumeCheckV3', wrong);
                assert.equal(result.ok, false); assert.match(result.error, /INVALID_INPUT/);
            }
            assert.equal(f.state.resumeReads, reads);
            const calls = f.state.resumeInputs.length;
            for (const text of ['{ private-picked-path', JSON.stringify({ ...f.request, oversized: '界'.repeat(3 * 1024 * 1024) })]) {
                const result = await poll(f.state, f.state.MindwtrHost.attachmentDraftResumeCheckV3(text));
                assert.equal(result.ok, false); assert.equal(result.error, 'INVALID_INPUT');
            }
            assert.equal(f.state.resumeInputs.length, calls, 'invalid UTF8 transport refuses before selected factory invocation');
            assert.equal(f.writes(), 0);
        });
        await check(async () => {
            for (const platform of ['android', undefined]) {
                const absent = makeState(0, [], platform);
                const result = await call(absent, 'attachmentDraftResumeCheckV3', f.request);
                assert.equal(result.ok, false); assert.match(result.error, /NOT_READY/); assert.equal(absent.resumeInputs.length, 0);
            }
            assert.equal((await poll(f.state, f.state.MindwtrHost.attachmentRequest('attachmentDraftResumeCheckV3', JSON.stringify(f.request)))).ok, false);
            f.state.persistenceFailure = 'existing failed save'; const before = f.state.resumeInputs.length;
            const result = await call(f.state, 'attachmentDraftResumeCheckV3', f.request); assert.equal(result.ok, false); assert.match(result.error, /SAVE_FAILED/);
            assert.equal(f.state.resumeInputs.length, before); f.state.persistenceFailure = null;
        });
        await check(async () => {
            const payload = JSON.parse(f.request.checkpoint.payloadJSON);
            const ordinary = { id: f.source.id, touchedBase: payload.touchedBase, checklistBase: payload.checklistBase,
                attachmentsBase: payload.attachmentsBase, attachments: payload.attachments };
            const refused = await call(f.state, 'taskEditorResumeCheck', ordinary); assert.equal(refused.ok, false); assert.match(refused.error, /INVALID_INPUT/);
            ordinary.attachments = ordinary.attachmentsBase;
            assert.equal((await call(f.state, 'taskEditorResumeCheck', ordinary)).ok, true, 'ordinary unchanged file half stays accepted');
            assert.equal((await call(f.state, 'attachmentDraftResumeCheckV3', f.request)).ok, true);
            assert.equal(f.writes(), 0);
        });
        await check(async () => {
            let entered, release;
            const started = new Promise((done) => { entered = done; }), held = new Promise((done) => { release = done; });
            f.state.onResumeRead = async () => { entered(); await held; };
            const ticket = f.state.MindwtrHost.attachmentDraftResumeCheckV3(JSON.stringify(f.request)); await started;
            f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Changed during read', f.source.id); release();
            const result = await poll(f.state, ticket); assert.equal(result.ok, false); assert.match(result.error, /STALE_REVISION/);
            assert.equal(f.db.prepare('SELECT title FROM tasks WHERE id = ?').get(f.source.id).title, 'Changed during read');
            f.state.onResumeRead = null; f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Opening', f.source.id);
            const secondStarted = new Promise((done) => { entered = done; }), secondHeld = new Promise((done) => { release = done; });
            f.state.onResumeRead = async () => { entered(); await secondHeld; };
            const second = f.state.MindwtrHost.attachmentDraftResumeCheckV3(JSON.stringify(f.request)); await secondStarted;
            const store = f.state.actualResumeStore; store.setState({ _allTasks: [...store.getState()._allTasks] }); release();
            const changed = await poll(f.state, second); assert.equal(changed.ok, false); assert.match(changed.error, /SAVE_FAILED/);
            f.state.onResumeRead = null; assert.equal(f.writes(), 0);
        });
    } finally { for (const db of databases) db.close(); }
    console.log(`Task270: ${cases} private owned resume checks (real bound269 factory + SQLite, exact retained inputs, ordinary sealed and iOS-only; Node VM)`);
}
// Task244: production direct handoff plus actual RN live-reference helper.
// Native proof/lease/filesystem and real-JSC ordering acceptance are Task243.
{
    const configureLocal = (state) => {
        state.localAttachmentTest = true;
        for (const name of ['fileCall', 'installerCall', 'fileAbort', 'fileDeleteNow', 'ioNext', 'ioBody']) state.__mindwtrNative[name] = () => '';
        state.__mindwtrNative.fileDirectories = () => JSON.stringify({ document: 'file:///library/documents/', cache: 'file:///library/cache/' });
        state.__mindwtrFileCall = async () => null;
        state.__mindwtrInstallerCall = async () => null;
    };
    const ID = '24400000-0000-4000-8000-000000000001';
    const TARGET = 'file:///library/documents/attachments/owned-café😀.pdf';
    const input = JSON.stringify({ version: 1, requestId: ID, targetURI: TARGET });
    const invalid = 'INVALID_INPUT: Invalid attachment Discard handoff';
    const unready = 'NOT_READY: Attachment Discard requires settled native storage';
    let cases = 0;
    const check = async (name, action) => { await action(); cases++; };
    const makeLocal = () => makeState(0, [], 'ios', configureLocal);
    const bootLocal = async (recovery = false) => {
        const state = makeLocal();
        assert.equal((await poll(state, recovery ? state.MindwtrHost.bootRecovery('', '') : state.MindwtrHost.boot())).ok, true);
        return state;
    };
    const call = (state, json = input, keep = () => '{"outcome":"referenced"}', retire = () => '{"outcome":"removed"}') =>
        state.MindwtrHost.attachmentDraftDiscardRetire(json, keep, retire);
    const refused = (state, json = input, expected = unready) => {
        let entered = 0;
        assert.throws(() => call(state, json, () => { entered++; return '{"outcome":"referenced"}'; },
            () => { entered++; return '{"outcome":"removed"}'; }), (error) => error.message === expected);
        assert.equal(entered, 0, 'all admission/input failures occur before either native callback');
    };
    await check('pure candidate dispatch before boot', async () => {
        const state = makeState(0, [], 'ios');
        const payload = JSON.stringify({ version: 2, taskID: 'task244', attachmentsOwned: true, attachmentsBase: [], attachments: [] });
        const candidateInput = { version: 1, historyVersion: 2, taskID: 'task244', managedDirectoryURI: 'file:///library/documents/attachments/',
            initialPayloadJSON: payload, checkpointPayloadJSON: payload, operations: [] };
        const ticket = state.MindwtrHost.attachmentDraftDiscardCandidates(JSON.stringify(candidateInput));
        assert.match(ticket, /^[1-9]\d*$/, 'candidate transport retains Promise ticket dispatch');
        assert.deepEqual(await poll(state, ticket), { ok: true, value: { version: 1, kind: 'owned-add-discard-candidates',
            taskID: 'task244', historyVersion: 2, candidates: [] } });
        assert.deepEqual(state.events, [], 'pure candidate admission does not load/flush/write');
        const bad = await poll(state, state.MindwtrHost.attachmentDraftDiscardCandidates('{private-content'));
        assert.deepEqual(bad, { ok: false, error: 'INVALID_INPUT' });
    });
    await check('candidate platform gate', async () => {
        const state = makeState(0);
        assert.match((await poll(state, state.MindwtrHost.attachmentDraftDiscardCandidates('{}'))).error, /^NOT_READY:/);
    });
    await check('availability-only Discard accepts truthful borrowed retention with sealed historical grammar', async () => {
        const local = await bootLocal(), raw = JSON.stringify({ version: 2, requestId: ID, targetURI: TARGET });
        let entered = 0;
        const keep = () => { entered++; return '{"outcome":"referenced"}'; };
        const borrowed = () => { entered++; return '{"outcome":"notOwned"}'; };
        assert.equal(local.MindwtrHost.attachmentDraftDiscardRetireV5(raw, keep, borrowed), '{"outcome":"notOwned"}');
        assert.equal(entered, 1);
        for (const invalidRaw of [input, JSON.stringify({ version: true, requestId: ID, targetURI: TARGET }),
            JSON.stringify({ version: 2, requestId: ID, targetURI: TARGET, extra: true })]) {
            assert.throws(() => local.MindwtrHost.attachmentDraftDiscardRetireV5(invalidRaw, keep, borrowed), /INVALID_INPUT/);
        }
        assert.throws(() => call(local, raw, keep, borrowed), /INVALID_INPUT/); assert.equal(entered, 1);
        assert.throws(() => call(local, input, keep, borrowed), /INVALID_INPUT/); assert.equal(entered, 2);
        assert.equal(local.MindwtrHost.attachmentDraftDiscardRetireV5(raw, borrowed, () => '{"outcome":"referenced"}'), '{"outcome":"referenced"}');
        assert.throws(() => call(local, input, borrowed, () => '{"outcome":"referenced"}'), /INVALID_INPUT/);
        local.ownerProjects = [{ attachments: [{ kind: 'file', uri: TARGET }] }];
        assert.equal(local.MindwtrHost.attachmentDraftDiscardRetireV5(raw, keep, borrowed), '{"outcome":"referenced"}');
        assert.equal(entered, 3);
        assert.throws(() => local.MindwtrHost.attachmentDraftDiscardRetireV5(raw, borrowed, borrowed), /INVALID_INPUT/);
        const calls = entered;
        for (const other of [makeLocal(), makeState(0, [], 'android', configureLocal)])
            assert.throws(() => other.MindwtrHost.attachmentDraftDiscardRetireV5(raw, keep, borrowed), /NOT_READY/);
        assert.equal(entered, calls);
    });
    await check('before validated boot', () => refused(makeLocal()));
    await check('normal bootRecovery ready state', async () => {
        const state = await bootLocal(true);
        assert.equal(call(state), '{"outcome":"removed"}', 'validated recovery load supports exact native replay handoff');
    });
    const state = await bootLocal();
    const unchanged = JSON.stringify({ events: state.events, data: state.fakeData, fileCalls: state.fileCalls, logOps: state.logOps });
    for (const outcome of ['removed', 'absent']) await check(`direct ${outcome}`, () => {
        let keep = 0, retire = 0;
        const result = call(state, input, () => { keep++; return '{"outcome":"referenced"}'; },
            () => { retire++; return JSON.stringify({ outcome }); });
        assert.equal(result, JSON.stringify({ outcome }), 'direct result is final JSON, never a ticket');
        assert.equal(keep, 0); assert.equal(retire, 1);
    });
    await check('callback inside JS before queued microtask', async () => {
        state.handoffOrder = [];
        state.handoffInput = input;
        state.keep244 = () => { state.handoffOrder.push('keep'); return '{"outcome":"referenced"}'; };
        state.retire244 = () => { state.handoffOrder.push('retire'); return '{"outcome":"absent"}'; };
        vm.runInNewContext(`Promise.resolve().then(() => handoffOrder.push('microtask'));
            handoffOrder.push('entered');
            globalThis.direct244 = MindwtrHost.attachmentDraftDiscardRetire(handoffInput, keep244, retire244);
            handoffOrder.push('returned');`, state);
        assert.deepEqual(state.handoffOrder, ['entered', 'retire', 'returned']);
        await new Promise((resolveTick) => setImmediate(resolveTick));
        assert.deepEqual(state.handoffOrder, ['entered', 'retire', 'returned', 'microtask']);
        assert.equal(state.direct244, '{"outcome":"absent"}');
    });
    for (const [name, owners, expected] of [
        ['live task', [{ attachments: [{ kind: 'file', uri: TARGET }] }], 'referenced'],
        ['archived readonly task', [{ status: 'archived', readOnly: true, attachments: [{ kind: 'file', uri: TARGET }] }], 'referenced'],
        ['deleted owner', [{ deletedAt: 'at', attachments: [{ kind: 'file', uri: TARGET }] }], 'removed'],
        ['deleted attachment', [{ attachments: [{ kind: 'file', uri: TARGET, deletedAt: 'at' }] }], 'removed'],
        ['link is not a file owner', [{ attachments: [{ kind: 'link', uri: TARGET }] }], 'removed'],
        ['URI exact spelling', [{ attachments: [{ kind: 'file', uri: TARGET.replace('café', 'caf%C3%A9') }] }], 'removed'],
    ]) await check(name, () => {
        state.lastLoaded.tasks = owners;
        assert.equal(call(state), JSON.stringify({ outcome: expected }));
        state.lastLoaded.tasks = [];
    });
    await check('live project', () => {
        state.ownerProjects = [{ status: 'archived', attachments: [{ kind: 'file', uri: TARGET }] }];
        assert.equal(call(state), '{"outcome":"referenced"}');
        state.ownerProjects = [];
    });
    let aliasCases276 = 0;
    const checkAlias276 = async (name, work) => { await check(name, work); aliasCases276++; };
    const aliasSuffix276 = 'mobile/Containers/Data/Application/27600000-0000-4000-8000-000000000001/Library/attachment-files/documents/attachments/owned.pdf';
    for (const [prefix, otherPrefix] of [['file:///var/', 'file:///private/var/'], ['file:///private/var/', 'file:///var/']]) {
        const targetURI = prefix + aliasSuffix276, aliasURI = otherPrefix + aliasSuffix276;
        const json = JSON.stringify({ version: 1, requestId: ID, targetURI });
        for (const where of ['task', 'project', 'deletedOwner', 'deletedAttachment']) await checkAlias276(`Discard alias ${where}`, async () => {
            const local = await bootLocal(), attachment = { kind: 'file', uri: aliasURI,
                ...(where === 'deletedAttachment' ? { deletedAt: 'at' } : {}) };
            const owner = { attachments: [attachment], ...(where === 'deletedOwner' ? { deletedAt: 'at' } : {}) };
            (where === 'project' ? local.ownerProjects : local.lastLoaded.tasks).push(owner);
            let keep = 0, retire = 0;
            const result = call(local, json, () => { keep++; return '{"outcome":"referenced"}'; },
                () => { retire++; return '{"outcome":"removed"}'; });
            const kept = where === 'task' || where === 'project';
            assert.equal(result, JSON.stringify({ outcome: kept ? 'referenced' : 'removed' }));
            assert.equal(keep, kept ? 1 : 0); assert.equal(retire, kept ? 0 : 1);
        });
        await checkAlias276('Discard alias generation mutation', async () => {
            const local = await bootLocal(); local.persistenceStatus = { generation: 0 };
            let reads = 0, entered = 0;
            const owner = {};
            Object.defineProperty(owner, 'attachments', { get() {
                if (++reads === 2) local.persistenceStatus.generation++;
                return [{ kind: 'file', uri: aliasURI }];
            } });
            local.ownerProjects.push(owner);
            const callback = () => { entered++; return '{"outcome":"referenced"}'; };
            assert.throws(() => call(local, json, callback, callback), (error) => error.message === unready);
            assert(reads >= 2, 'mutation occurs during the sibling-alias reference comparison');
            assert.equal(entered, 0, 'all alias checks retain the same captured generation');
        });
    }
    for (const [prefix, otherPrefix] of [['file:///variant/', 'file:///private/variant/'], ['file:///private/variant/', 'file:///variant/']]) await checkAlias276('Discard unrelated URI prefix', async () => {
        const local = await bootLocal();
        local.ownerProjects.push({ attachments: [{ kind: 'file', uri: otherPrefix + aliasSuffix276 }] });
        assert.equal(call(local, JSON.stringify({ version: 1, requestId: ID, targetURI: prefix + aliasSuffix276 })), '{"outcome":"removed"}',
            'an unrelated prefix cannot gain a system-alias keep decision');
    });
    console.log(`Task276: ${aliasCases276} v1 Discard alias-reference checks (same captured generation; no physical normalization)`);
    await check('optimistic queued deletion cannot hide a durable live owner', () => {
        const oldLoaded = state.lastLoaded, oldDurable = state.fakeData;
        state.fakeData = { ...oldDurable, tasks: [{ attachments: [{ kind: 'file', uri: TARGET }] }] };
        state.lastLoaded = { ...state.fakeData, tasks: [{ deletedAt: 'optimistic', attachments: [{ kind: 'file', uri: TARGET }] }] };
        state.persistenceStatus = { generation: 1, queued: 1 };
        assert.equal(state.persistenceFailure, null, 'failure-only requireSaved would pass');
        refused(state);
        assert.equal(state.fakeData.tasks[0].deletedAt, undefined, 'fake durable owner remains live');
        state.persistenceStatus = null; state.lastLoaded = oldLoaded; state.fakeData = oldDurable;
    });
    await check('deleted project with a separate live task retains target', () => {
        state.ownerProjects = [{ deletedAt: 'at', attachments: [{ kind: 'file', uri: TARGET }] }];
        assert.equal(call(state), '{"outcome":"removed"}');
        state.lastLoaded.tasks = [{ attachments: [{ kind: 'file', uri: TARGET }] }];
        assert.equal(call(state), '{"outcome":"referenced"}');
        state.lastLoaded.tasks = []; state.ownerProjects = [];
    });
    for (const flag of ['queued', 'inFlight', 'immediate', 'retrying', 'failed']) await check(`unsaved ${flag}`, () => {
        state.persistenceStatus = { generation: 0, [flag]: 1 };
        refused(state); state.persistenceStatus = null;
    });
    for (const [field, value] of [['persistenceFailure', { message: 'private failure' }], ['storeLoading', true],
        ['storeEditLocks', 1], ['sandbox', true], ['workspaceTransition', true]]) await check(`guard ${field}`, () => {
        const previous = state[field]; state[field] = value;
        refused(state); state[field] = previous;
    });
    await check('foreign adapter', () => {
        const previous = state.adapter; state.adapter = {};
        refused(state); state.adapter = previous;
    });
    await check('normal readiness failure', () => {
        state.backupReadinessResult = { ok: false, error: { code: 'NOT_READY', message: 'private reload' } };
        refused(state); state.backupReadinessResult = { ok: true, value: {} };
    });
    await check('thrown readiness content is redacted', () => {
        state.onReadiness = () => { throw new Error('private task/path'); };
        refused(state); state.onReadiness = null;
    });
    for (const owner of ['task', 'project']) await check(`changed ${owner} reference`, () => {
        let reads = 0;
        state.onStateRead = () => {
            if (++reads === 2) {
                if (owner === 'task') state.lastLoaded.tasks = [...state.lastLoaded.tasks];
                else state.ownerProjects = [...state.ownerProjects];
            }
        };
        refused(state); state.onStateRead = null;
    });
    await check('changed generation', () => {
        let reads = 0;
        state.persistenceStatus = { generation: 0 };
        state.onPersistenceStatus = () => { if (++reads === 2) state.persistenceStatus.generation++; };
        refused(state); state.onPersistenceStatus = null; state.persistenceStatus = null;
    });
    for (const field of ['adapter', 'workspaceTransition']) await check(`late ${field} change during readiness`, () => {
        const previous = state[field]; let reads = 0;
        state.onReadiness = () => { if (++reads === 2) state[field] = field === 'adapter' ? {} : true; };
        refused(state); state.onReadiness = null; state[field] = previous;
    });
    await check('unfinished direct document work and completed unpolled slot', async () => {
        let release;
        state.backupPrepareHold = new Promise((resolveHeld) => { release = resolveHeld; });
        const ticket = state.MindwtrHost.backupDocumentPrepare('{}');
        refused(state);
        release(); await new Promise((resolveTick) => setImmediate(resolveTick));
        assert.equal(call(state), '{"outcome":"removed"}', 'a completed slot is not unresolved async work');
        assert.equal((await poll(state, ticket)).ok, true);
        state.backupPrepareHold = null;
    });
    for (const json of ['{private text', 'null', '[]', 'true', '{}',
        JSON.stringify({ version: '1', requestId: ID, targetURI: TARGET }),
        JSON.stringify({ version: 1, requestId: ID.toUpperCase().replace('244', 'ABC'), targetURI: TARGET }),
        JSON.stringify({ version: 1, requestId: ID, targetURI: '' }),
        JSON.stringify({ version: 1, requestId: ID, targetURI: '界'.repeat(5_462) }),
        JSON.stringify({ version: 1, requestId: ID, targetURI: TARGET, proof: 'untrusted' }),
        ' '.repeat(64 * 1024) + input,
    ]) await check('invalid exact input', () => refused(state, json, invalid));
    for (const which of ['keep', 'retire']) await check(`invalid ${which} callback type`, () => {
        let entered = 0;
        const callback = () => { entered++; return '{"outcome":"removed"}'; };
        assert.throws(() => call(state, input, which === 'keep' ? null : callback, which === 'retire' ? null : callback),
            (error) => error.message === invalid);
        assert.equal(entered, 0);
    });
    for (const result of ['{private result', 'null', '[]', '{}', '{"outcome":"referenced"}',
        '{"outcome":"removed","proof":"untrusted"}', '界'.repeat(342), 1, Promise.resolve('{"outcome":"removed"}')]) {
        await check('invalid retire outcome no fallback', () => {
            let keep = 0, retire = 0;
            assert.throws(() => call(state, input, () => { keep++; return '{"outcome":"referenced"}'; },
                () => { retire++; return result; }), (error) => error.message === invalid);
            assert.equal(keep, 0); assert.equal(retire, 1);
        });
    }
    await check('keep rejects destructive outcome with no fallback', () => {
        state.ownerProjects = [{ attachments: [{ kind: 'file', uri: TARGET }] }];
        let keep = 0, retire = 0;
        assert.throws(() => call(state, input, () => { keep++; return '{"outcome":"removed"}'; },
            () => { retire++; return '{"outcome":"removed"}'; }), (error) => error.message === invalid);
        assert.equal(keep, 1); assert.equal(retire, 0); state.ownerProjects = [];
    });
    await check('callback exception fixed refusal no fallback', () => {
        let keep = 0, retire = 0;
        assert.throws(() => call(state, input, () => { keep++; return '{"outcome":"referenced"}'; },
            () => { retire++; throw new Error('private source/hash'); }), (error) => error.message === unready);
        assert.equal(keep, 0); assert.equal(retire, 1);
    });
    await check('valid callback string preserved byte for byte', () => {
        const result = ' \n{"outcome":"absent"} ';
        assert.equal(call(state, input, () => '{"outcome":"referenced"}', () => result), result);
    });
    await check('direct handoff creates no flush/write/file bridge/diagnostic work', () => {
        // Reset only harness document dispatch bookkeeping from the deliberate
        // held-Promise test; direct calls never touched these domain arrays.
        const before = JSON.stringify({ events: state.events, data: state.fakeData, fileCalls: state.fileCalls, logOps: state.logOps });
        assert.equal(call(state), '{"outcome":"removed"}');
        assert.equal(JSON.stringify({ events: state.events, data: state.fakeData, fileCalls: state.fileCalls, logOps: state.logOps }), before);
        assert.equal(JSON.parse(unchanged).data.tasks.length, 0);
    });
    for (const variant of ['partial', 'refused', 'android']) await check(`${variant} capability gate`, async () => {
        const unavailable = makeState(0, [], variant === 'android' ? undefined : 'ios', (state) => {
            configureLocal(state);
            if (variant === 'partial') delete state.__mindwtrNative.ioBody;
            if (variant === 'refused') state.__mindwtrNative.fileDirectories = () => '!MindwtrNativeError:private capability error';
        });
        assert.equal((await poll(unavailable, unavailable.MindwtrHost.boot())).ok, true);
        refused(unavailable);
    });
    await check('iOS KV presence preserves local attachment authority and does not activate Sync or AI', async () => {
        let calls = 0;
        const local = makeState(0, [], 'ios', (state) => {
            configureLocal(state);
            for (const name of ['kvMultiGet', 'kvMultiSet', 'kvMultiRemove', 'secretCall', 'cryptoCall', 'netFetch', 'bgSyncSchedule']) {
                state.__mindwtrNative[name] = () => { calls++; throw new Error('Unexpected device service activation'); };
            }
        });
        assert.deepEqual(Object.keys(local.contractBindings).filter((name) => local.contractBindings[name] !== undefined), ['reminderPlatform', 'attachments']);
        assert.equal((await poll(local, local.MindwtrHost.boot())).ok, true);
        assert.equal(local.localShaInstallCount, 1);
        assert.equal(call(local), '{"outcome":"removed"}', 'existing synchronous local Discard remains admitted');
        assert.equal(calls, 0);
    });
    await check('nativeSync gate stays explicit with local-only construction', () => {
        const entry = readFileSync(resolve(app, 'bundle/host-entry.ts'), 'utf8');
        assert.match(entry, /const localAttachments = nativeSync \? null : createNativeLocalAttachmentsForHost\(\)/);
        assert.match(entry, /const settledAttachmentDiscardState[\s\S]*?nativeSync !== null/);
    });
    await check('existing owned draft acknowledgment pairs and tags remain sealed', async () => {
        for (const [operation, outcome, tag] of [['add', 'confirmed', 'v1.3.4/ios-attachment-draft-owned'],
            ['checkpoint', 'replayed', 'v1.3.4/ios-attachment-draft-owned'], ['save', 'confirmed', 'v1.3.5/ios-attachment-owned-save'],
            ['discard', 'retained', 'v1.3.4/ios-attachment-draft-owned'], ['discard-capacity', 'confirmed', 'v1.3.5/ios-owned-discard-capacity']]) {
            assert.equal((await poll(state, state.MindwtrHost.attachmentDraftAcknowledged(operation, outcome))).ok, true);
            const marker = JSON.parse(state.logText.trim().split('\n').at(-1));
            assert.deepEqual(marker.context, { releaseCheck: tag, operation, outcome });
        }
    });
    await check('terminal diagnostic after lost optional capability', async () => {
        const absent = makeState(0, [], 'ios');
        for (const pair of [['add', 'confirmed'], ['save', 'confirmed'], ['discard-finish', 'replayed'], ['discard-finish', 'retained']]) {
            assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged(...pair))).ok, true);
        }
        assert.equal(absent.logText, null, 'only the exact new terminal pair bypasses capability');
        assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('discard-finish', 'confirmed'))).ok, true);
        const marker = JSON.parse(absent.logText.trim());
        assert.deepEqual(marker.context, { releaseCheck: 'v1.3.5/ios-owned-discard-finish', operation: 'discard-finish', outcome: 'confirmed' });
        absent.logFailure = 'private diagnostics failure';
        assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('discard-finish', 'confirmed'))).ok, true,
            'diagnostic IO cannot invalidate durable completion');
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('discard-finish', 'confirmed'))).ok, true);
        assert.equal(android.logText, null, 'terminal capability exception remains iOS-only');
    });
    await check('logical unstarted Discard diagnostic stays distinct and exact', async () => {
        const local = makeState(0, [], 'ios', configureLocal);
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', 'confirmed'))).ok, true);
        const marker = JSON.parse(local.logText.trim());
        assert.deepEqual(marker.context, { releaseCheck: 'v1.3.5/ios-unstarted-add-discard', operation: 'discard-unstarted', outcome: 'confirmed' });
        const before = local.logText;
        for (const outcome of ['replayed', 'retained', 'released', 'discarded', '']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', outcome))).ok, true);
        }
        assert.equal(local.logText, before, 'no other logical pair can produce an acknowledgment');
    });
    await check('logical unstarted Discard terminal diagnostic survives capability and log loss', async () => {
        const absent = makeState(0, [], 'ios');
        for (const outcome of ['replayed', 'retained', 'released', 'discarded']) {
            assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', outcome))).ok, true);
        }
        assert.equal(absent.logText, null, 'only confirmed may bypass optional capability loss');
        assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', 'confirmed'))).ok, true);
        assert.deepEqual(JSON.parse(absent.logText.trim()).context,
            { releaseCheck: 'v1.3.5/ios-unstarted-add-discard', operation: 'discard-unstarted', outcome: 'confirmed' });
        const before = absent.logText;
        absent.logFailure = 'private diagnostics failure';
        assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', 'confirmed'))).ok, true);
        assert.equal(absent.logText, before, 'diagnostic failure does not fabricate a marker or invalidate completion');
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('discard-unstarted', 'confirmed'))).ok, true);
        assert.equal(android.logText, null, 'logical terminal capability exception remains iOS-only');
    });
    await check('owned Remove acknowledgment is exact and survives optional capability loss', async () => {
        for (const local of [makeState(0, [], 'ios'), makeState(0, [], 'ios', configureLocal)]) {
            for (const outcome of ['confirmed', 'replayed']) {
                assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('remove', outcome))).ok, true);
                assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
                    { releaseCheck: 'v1.3.5/ios-attachment-draft-remove', operation: 'remove', outcome });
            }
            const before = local.logText;
            for (const outcome of ['retained', 'removed', 'saved', '']) {
                assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('remove', outcome))).ok, true);
            }
            local.logFailure = 'private diagnostics failure';
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('remove', 'confirmed'))).ok, true);
            assert.equal(local.logText, before);
        }
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('remove', 'confirmed'))).ok, true);
        assert.equal(android.logText, null);
    });
    await check('mixed Save diagnostic distinguishes domain success from settlement', async () => {
        const local = makeState(0, [], 'ios');
        for (const outcome of ['domainSaved', 'settled']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('mixed-save', outcome))).ok, true);
            assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
                { releaseCheck: 'v1.3.5/ios-attachment-mixed-save', operation: 'mixed-save', outcome });
        }
        const before = local.logText;
        for (const outcome of ['confirmed', 'replayed', 'removed', '']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('mixed-save', outcome))).ok, true);
        }
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('mixed-save', 'settled'))).ok, true);
        assert.equal(local.logText, before);
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('mixed-save', 'settled'))).ok, true);
        assert.equal(android.logText, null);
    });
    await check('mixed Discard completion diagnostic survives capability loss without claiming baseline removal', async () => {
        const local = makeState(0, [], 'ios');
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('discard-mixed', 'confirmed'))).ok, true);
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-attachment-mixed-discard', operation: 'discard-mixed', outcome: 'confirmed' });
        const before = local.logText;
        for (const outcome of ['retained', 'replayed', 'removed', 'settled', '']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('discard-mixed', outcome))).ok, true);
        }
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('discard-mixed', 'confirmed'))).ok, true);
        assert.equal(local.logText, before);
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('discard-mixed', 'confirmed'))).ok, true);
        assert.equal(android.logText, null);
    });
    await check('mixed Add acknowledgment has fixed outcomes and survives historical capability loss', async () => {
        const local = makeState(0, [], 'ios');
        for (const outcome of ['confirmed', 'replayed']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('add-mixed', outcome))).ok, true);
            assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
                { releaseCheck: 'v1.3.5/ios-attachment-mixed-add', operation: 'add-mixed', outcome });
        }
        const before = local.logText;
        for (const outcome of ['retained', 'removed', 'settled', '']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('add-mixed', outcome))).ok, true);
        }
        assert.equal(local.logText, before);
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('add-mixed', 'confirmed'))).ok, true);
        assert.equal(local.logText, before);
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('add-mixed', 'confirmed'))).ok, true);
        assert.equal(android.logText, null);
    });
    await check('selfhosted availability acknowledgments are fixed, private, iOS-only and best effort', async () => {
        const local = makeState(0, [], 'ios');
        for (const operation of ['selfhosted-task-availability', 'selfhosted-project-availability']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, 'confirmed'))).ok, true);
            const marker = JSON.parse(local.logText.trim().split('\n').at(-1));
            assert.deepEqual(marker.context, { releaseCheck: 'v1.3.5/ios-selfhosted-file-availability', operation, outcome: 'confirmed' });
            const before = local.logText;
            for (const outcome of ['retained', 'replayed', 'removed', 'settled', 'private://credential/task']) {
                assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, outcome))).ok, true);
            }
            assert.equal(local.logText, before);
            local.logFailure = 'private diagnostics failure';
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, 'confirmed'))).ok, true);
            assert.equal(local.logText, before); local.logFailure = null;
            const android = makeState(0);
            assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged(operation, 'confirmed'))).ok, true);
            assert.equal(android.logText, null);
        }
        const before = local.logText;
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('selfhosted-task-availability/private', 'confirmed'))).ok, true);
        assert.equal(local.logText, before);
    });
    await check('provider Add acknowledgment is iOS-only, fixed, and independent of optional diagnostics', async () => {
        const local = makeState(0, [], 'ios');
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('provider-add', 'confirmed'))).ok, true);
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-attachment-provider-add', operation: 'provider-add', outcome: 'confirmed' });
        const before = local.logText;
        for (const outcome of ['retained', 'replayed', 'removed', 'settled', '']) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('provider-add', outcome))).ok, true);
        }
        assert.equal(local.logText, before);
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('provider-add', 'confirmed'))).ok, true);
        assert.equal(local.logText, before);
        const android = makeState(0);
        assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged('provider-add', 'confirmed'))).ok, true);
        assert.equal(android.logText, null);
    });
    await check('complete Save and cancellation Undo acknowledgment pairs are fixed and capability-independent on iOS', async () => {
        const local = makeState(0, [], 'ios');
        for (const [operation, outcome] of [['complete-save', 'domainSaved'], ['complete-save', 'settled'], ['complete-cancel-undo', 'confirmed']]) {
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, outcome))).ok, true);
            assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
                { releaseCheck: 'v1.3.5/ios-attachment-complete-save', operation, outcome });
        }
        const rawSaveMarkers = local.logText.trim().split('\n').map(JSON.parse)
            .filter((entry) => entry.context?.releaseCheck === 'v1.3.5/ios-owned-raw-row-save');
        assert.deepEqual(rawSaveMarkers.map((entry) => entry.context), [
            { releaseCheck: 'v1.3.5/ios-owned-raw-row-save', operation: 'complete-save', outcome: 'domainSaved' },
        ]);
        const before = local.logText;
        for (const operation of ['complete-save', 'complete-cancel-undo']) for (const outcome of ['retained', 'replayed', 'removed', '', 'unknown'])
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, outcome))).ok, true);
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('complete-save', 'confirmed'))).ok, true);
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('complete-cancel-undo', 'settled'))).ok, true);
        assert.equal(local.logText, before);
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('complete-save', 'settled'))).ok, true);
        assert.equal(local.logText, before);
        for (const platform of ['android', undefined]) {
            const absent = makeState(0, [], platform);
            assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('complete-save', 'domainSaved'))).ok, true);
            assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('complete-cancel-undo', 'confirmed'))).ok, true);
            assert.equal(absent.logText, null);
        }
    });
    await check('an extra raw-row marker failure does not suppress the existing complete Save acknowledgment', async () => {
        const local = makeState(0, [], 'ios'), write = local.__mindwtrNative.logFile;
        let failOnce = true;
        local.__mindwtrNative.logFile = (operation, text) => {
            if (operation === 'append' && failOnce) { failOnce = false; return '!MindwtrNativeError:injected marker failure'; }
            return write(operation, text);
        };
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('complete-save', 'domainSaved'))).ok, true);
        assert.equal(failOnce, false);
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-attachment-complete-save', operation: 'complete-save', outcome: 'domainSaved' });
    });
    await check('Project local planning reuses RN classification without resolving availability or writing metadata', async () => {
        const local = makeState(0, [], 'ios');
        const attachments = [
            { id: 'document', kind: 'file', title: 'Document', uri: 'file:///managed/document.txt', mimeType: 'text/plain', localStatus: 'missing' },
            { id: 'image', kind: 'file', title: 'Image', uri: 'file:///managed/image.png', mimeType: 'image/png' },
            { id: 'audio', kind: 'file', title: 'Audio', uri: 'file:///managed/audio.wav', mimeType: 'audio/wav' },
        ];
        local.ownerProjects = [{ id: 'p', status: 'active', attachments }];
        const request = (id) => JSON.stringify({ projectId: 'p', attachmentId: id });
        const plan = (state, json, available) => poll(state, state.MindwtrHost.projectLocalFileOpenPlan(json, available));
        for (const status of ['active', 'archived']) {
            local.ownerProjects[0].status = status;
            const before = JSON.stringify(local.ownerProjects);
            for (const [id, kind] of [['document', 'file'], ['image', 'image'], ['audio', 'file']]) {
                const result = await plan(local, request(id), true);
                assert.equal(result.ok, true); assert.equal(result.value.status, 'available');
                assert.equal(result.value.open.kind, kind); assert.equal(result.value.update, null);
                assert.equal(result.value.message, null);
            }
            assert.deepEqual((await plan(local, request('document'), false)).value,
                { status: 'unavailable', message: 'attachments.missing', update: null, open: null });
            assert.equal(JSON.stringify(local.ownerProjects), before);
        }
        for (const invalid of [{ projectId: 'p', attachmentId: 'missing' }, { projectId: 'p', attachmentId: 'document', extra: true },
            { projectId: 'missing', attachmentId: 'document' }, { projectId: 'p', attachmentId: '' }])
            assert.equal((await plan(local, JSON.stringify(invalid), true)).ok, false);
        for (const available of [null, 'true', 1]) assert.equal((await plan(local, request('document'), available)).ok, false);
        attachments[0].deletedAt = '2026-10-06T00:00:00Z';
        assert.equal((await plan(local, request('document'), true)).ok, false); delete attachments[0].deletedAt;
        local.ownerProjects[0].deletedAt = '2026-10-06T00:00:00Z';
        assert.equal((await plan(local, request('document'), true)).ok, false); delete local.ownerProjects[0].deletedAt;
        attachments.push({ ...attachments[0] });
        assert.equal((await plan(local, request('document'), true)).ok, false); attachments.pop();
        assert.deepEqual(local.attachmentInputs, []); assert.deepEqual(local.fileCalls, []);
        assert.equal(local.saveCount, 0);
        assert.equal((await plan(makeState(0), request('document'), true)).ok, false);
    });
    await check('Task settled local planning preserves original metadata and never resolves availability', async () => {
        const local = makeState(0, [], 'ios');
        const attachments = [
            { id: 'document', kind: 'file', title: 'Document', uri: 'file:///old/document.txt', mimeType: 'text/plain', fileHash: 'a'.repeat(64) },
            { id: 'image', kind: 'file', title: 'Image', uri: 'file:///old/image.png', mimeType: 'image/png' },
            { id: 'audio', kind: 'file', title: 'Audio', uri: 'file:///old/audio.wav', mimeType: 'audio/wav' },
        ];
        for (const item of attachments) { item.createdAt = '2026-10-06T00:00:00Z'; item.updatedAt = item.createdAt; }
        const saved = { id: 'task285', attachments };
        local.ownerTaskMap = new Map([['task285', saved]]);
        const request = (id, rows = attachments) => JSON.stringify({ owner: { kind: 'task', taskId: 'task285', attachments: rows }, attachmentId: id });
        const plan = (state, json, available) => poll(state, state.MindwtrHost.taskLocalFileOpenPlan(json, available));
        const before = JSON.stringify(saved);
        for (const readOnly of [false, true]) {
            local.localTaskReadOnly = readOnly;
            for (const [id, kind] of [['document', 'file'], ['image', 'image'], ['audio', 'audio']]) {
                const result = await plan(local, request(id), true);
                assert.equal(result.ok, true); assert.equal(result.value.status, 'available');
                assert.equal(result.value.open.kind, kind); assert.equal(result.value.update, null);
                const selected = attachments.find((item) => item.id === id);
                assert.equal(kind === 'file' ? result.value.open.uri : result.value.open.attachment.uri, selected.uri);
                assert.equal('relocatedFrom' in result.value, false, 'Only Swift may produce resolved result authority');
            }
        }
        const hydrated = local.hydrateTaskAttachments285(attachments);
        assert.equal(Object.hasOwn(hydrated[0], 'cloudKey'), true); assert.equal(hydrated[0].cloudKey, undefined);
        assert.deepEqual(JSON.parse(JSON.stringify(hydrated)), attachments, 'Actual SQLite hydration serializes to exactly the original wire metadata');
        saved.attachments = hydrated;
        for (const [id, kind] of [['document', 'file'], ['image', 'image'], ['audio', 'audio']]) {
            const result = await plan(local, request(id), true);
            assert.equal(result.ok, true, 'Hydrated own-undefined fields must not invalidate an exact original JSON selection');
            assert.equal(result.value.open.kind, kind);
        }
        hydrated[0].cloudKey = null;
        assert.equal((await plan(local, request('document'), true)).ok, false, 'Defined null remains different from an omitted field');
        hydrated[0].cloudKey = undefined; hydrated[0].pendingContentUpload = false;
        assert.equal((await plan(local, request('document'), true)).ok, false, 'Defined false is never discarded as undefined');
        hydrated[0].pendingContentUpload = undefined;
        assert.deepEqual((await plan(local, request('document'), false)).value,
            { status: 'unavailable', message: 'attachments.missing', update: null, open: null });
        saved.attachments = attachments;
        for (const rows of [[{ ...attachments[0], uri: 'file:///fabricated/current.txt' }],
            [{ ...attachments[0], fileHash: 'b'.repeat(64) }], [{ ...attachments[0], title: 'Changed' }],
            [...attachments, { ...attachments[0] }]]) assert.equal((await plan(local, request('document', rows), true)).ok, false);
        for (const available of [null, 1, 'true']) assert.equal((await plan(local, request('document'), available)).ok, false);
        assert.equal((await plan(local, request('missing'), true)).ok, false);
        assert.equal((await plan(local, JSON.stringify({ owner: { kind: 'task', taskId: 'task285', attachments }, attachmentId: 'document', extra: true }), true)).ok, false);
        for (const field of ['deletedAt', 'purgedAt']) {
            saved[field] = '2026-10-06T00:00:00Z'; assert.equal((await plan(local, request('document'), true)).ok, false); delete saved[field];
        }
        attachments[0].deletedAt = '2026-10-06T00:00:00Z';
        assert.equal((await plan(local, request('document'), true)).ok, false); delete attachments[0].deletedAt;
        local.ownerTaskMap = new Map(); assert.equal((await plan(local, request('document'), true)).ok, false);
        assert.equal((await plan(makeState(0), request('document'), true)).ok, false);
        assert.equal(JSON.stringify(saved), before);
        assert.deepEqual(local.attachmentInputs, []); assert.deepEqual(local.fileCalls, []); assert.equal(local.saveCount, 0);
    });
    await check('Relocated Open markers are fixed, exportable, best effort and preserve prior markers', async () => {
        for (const surface of ['task', 'project']) {
            const operation = `relocated-${surface}-file-open`, local = makeState(0, [], 'ios');
            local.settings = { diagnostics: { loggingEnabled: false } };
            const ack = (state, name = operation, outcome = 'prepared') => poll(state, state.MindwtrHost.attachmentDraftAcknowledged(name, outcome));
            assert.equal((await ack(local)).ok, true);
            assert.deepEqual(JSON.parse(local.logText.trim()).context,
                { releaseCheck: 'v1.3.5/ios-relocated-file-open', operation, outcome: 'prepared', surface });
            const before = local.logText;
            for (const name of ['relocated-file-open', `${operation}-extra`, 'relocated-file-open/task']) assert.equal((await ack(local, name)).ok, true);
            for (const outcome of ['confirmed', 'replayed', '', null]) assert.equal((await ack(local, operation, outcome)).ok, true);
            assert.equal(local.logText, before);
            assert.deepEqual((await poll(local, local.MindwtrHost.logShare())).value, { path: 'files/logs/mindwtr.log' });
            const exported = local.logText;
            local.logFailure = 'private diagnostics failure'; assert.equal((await ack(local)).ok, true); assert.equal(local.logText, exported);
            for (const platform of ['android', undefined]) {
                const other = makeState(0, [], platform); assert.equal((await ack(other)).ok, true); assert.equal(other.logText, null);
            }
        }
    });
    await check('availability consumer markers persist only fixed iOS acknowledgment pairs', async () => {
        const pairs = [['availability-resume', 'validated'], ['availability-checkpoint', 'confirmed'],
            ['availability-save', 'domainSaved'], ['availability-save', 'settled'], ['availability-discard', 'settled']];
        for (const [operation, outcome] of pairs) {
            const local = makeState(0, [], 'ios');
            local.settings = { diagnostics: { loggingEnabled: false } };
            const ack = (state, op = operation, result = outcome) => poll(state, state.MindwtrHost.attachmentDraftAcknowledged(op, result));
            assert.equal((await ack(local)).ok, true);
            assert.deepEqual(JSON.parse(local.logText.trim()).context,
                { releaseCheck: 'v1.3.5/ios-task-availability-consumers', operation, outcome });
            const before = local.logText;
            for (const result of ['validated', 'confirmed', 'domainSaved', 'settled', 'prepared', 'downloaded', '', null]) {
                if (!pairs.some(([op, accepted]) => op === operation && accepted === result))
                    assert.equal((await ack(local, operation, result)).ok, true);
            }
            assert.equal((await ack(local, operation + '-extra')).ok, true);
            assert.equal(local.logText, before);
            assert.deepEqual((await poll(local, local.MindwtrHost.logShare())).value, { path: 'files/logs/mindwtr.log' });
            const exported = local.logText;
            local.logFailure = 'private diagnostics failure'; assert.equal((await ack(local)).ok, true); assert.equal(local.logText, exported);
            for (const platform of ['android', undefined]) {
                const other = makeState(0, [], platform); assert.equal((await ack(other)).ok, true); assert.equal(other.logText, null);
            }
        }
    });
    await check('owned resume acknowledgment is iOS-only and fixed without claiming Save or UI hydration', async () => {
        const local = makeState(0, [], 'ios');
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('owned-resume', 'validated'))).ok, true);
        assert.deepEqual(JSON.parse(local.logText.trim().split('\n').at(-1)).context,
            { releaseCheck: 'v1.3.5/ios-owned-editor-resume', operation: 'owned-resume', outcome: 'validated' });
        const before = local.logText;
        for (const outcome of ['confirmed', 'replayed', 'domainSaved', 'settled', 'resumed', '', 'unknown'])
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('owned-resume', outcome))).ok, true);
        assert.equal(local.logText, before);
        local.logFailure = 'private diagnostics failure';
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('owned-resume', 'validated'))).ok, true);
        assert.equal(local.logText, before);
        for (const platform of ['android', undefined]) {
            const absent = makeState(0, [], platform);
            assert.equal((await poll(absent, absent.MindwtrHost.attachmentDraftAcknowledged('owned-resume', 'validated'))).ok, true);
            assert.equal(absent.logText, null);
        }
    });
    await check('cached Project private bridges refuse boot and non-iOS authority', async () => {
        const request = JSON.stringify({ projectId: 'cached-410', attachmentId: '41000000-1111-4111-8111-111111111111',
            revision: 'fixture', managedDirectoryURI: 'file:///documents/attachments/' });
        for (const platform of ['ios', 'android', undefined]) {
            const state = makeState(0, [], platform);
            for (const [name, args] of [
                ['projectAttachmentCachedAvailabilityPreflight', [request, null]],
                ['projectAttachmentCachedAvailability', [request, 'file:///documents/attachments/41000000-1111-4111-8111-111111111111.txt']],
            ]) {
                const answer = await poll(state, state.MindwtrHost[name](...args));
                assert.equal(answer.ok, false); assert.match(answer.error, /^NOT_READY:/);
            }
            assert.equal(state.logText, null);
        }
    });
    for (const [operation, releaseCheck, accepted = 'confirmed'] of [
        ['preexisting-journal-replay', 'v1.3.5/ios-preexisting-attachment-journal-replay'],
        ['container-relocation', 'v1.3.5/ios-attachment-container-recovery'],
        ['photo-add', 'v1.3.5/ios-task-photo-add'],
        ['audio-playback', 'v1.3.5/ios-task-audio-playback', 'started'],
        ['file-open', 'v1.3.5/ios-local-file-open', 'prepared'],
        ['project-file-open', 'v1.3.5/ios-project-local-file-open', 'prepared'],
        ['project-file-remove', 'v1.3.5/ios-project-file-remove', 'saved'],
        ['project-file-add', 'v1.3.5/ios-project-file-add', 'saved'],
        ['project-file-add', 'v1.3.5/ios-project-file-add', 'abandoned'],
        ['cached-project-availability', 'v1.3.5/ios-cached-project-availability'],
        ...['saved', 'abandoned', 'refused', 'cleanup-pending'].map(outcome => ['selfhosted-project-download', 'v1.3.5/ios-selfhosted-project-download', outcome]),
        ['project-file-hash', 'v1.3.5/ios-project-file-hash', 'saved'],
        ['task-file-hash', 'v1.3.5/ios-task-file-hash', 'saved'],
    ]) await check(`${operation} acknowledgment is fixed, exportable and best effort`, async () => {
        const local = makeState(0, [], 'ios');
        local.settings = { diagnostics: { loggingEnabled: false } };
        const acknowledge = (state, outcome = accepted) => poll(state,
            state.MindwtrHost.attachmentDraftAcknowledged(operation, outcome));
        assert.equal((await acknowledge(local)).ok, true);
        assert.deepEqual(JSON.parse(local.logText.trim()).context, {
            releaseCheck, operation, outcome: accepted,
        });
        const before = local.logText;
        for (const outcome of ['replayed', 'settled', '', null]) assert.equal((await acknowledge(local, outcome)).ok, true);
        assert.equal(local.logText, before);
        assert.deepEqual((await poll(local, local.MindwtrHost.logShare())).value, { path: 'files/logs/mindwtr.log' });
        const exported = local.logText;
        local.logFailure = 'private diagnostics failure';
        assert.equal((await acknowledge(local)).ok, true);
        assert.equal(local.logText, exported);
        for (const platform of ['android', undefined]) {
            const other = makeState(0, [], platform);
            assert.equal((await acknowledge(other)).ok, true);
            assert.equal(other.logText, null);
        }
    });
    await check('editor acceptance acknowledgment forces five fixed file markers with or without local capability', async () => {
        for (const local of [makeState(0, [], 'ios'), makeState(0, [], 'ios', configureLocal)]) {
            local.settings = { diagnostics: { loggingEnabled: false } };
            for (const operation of ['add', 'remove', 'save', 'discard', 'recover']) {
                assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(`editor-${operation}`, 'confirmed'))).ok, true);
                const marker = JSON.parse(local.logText.trim().split('\n').at(-1));
                assert.deepEqual({ ...marker, ts: '' }, { ts: '', level: 'info', scope: 'native-ios',
                    message: 'Native iOS attachment draft acknowledged',
                    context: { releaseCheck: 'v1.3.5/ios-editor-owned-attachments', operation, outcome: 'confirmed' } });
                assert.match(marker.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
            }
            assert.equal(local.logOps.filter((operation) => operation === 'append').length, 5);
            assert.deepEqual(local.events, []); assert.deepEqual(local.fileCalls, []);
            const exported = await poll(local, local.MindwtrHost.logShare());
            assert.equal(exported.ok, true);
            assert.deepEqual(exported.value, { path: 'files/logs/mindwtr.log' });
            assert.equal(local.logText.split('\n').filter((line) => line.includes('v1.3.5/ios-editor-owned-attachments')).length, 5,
                'the same file exported by Diagnostics contains each model acknowledgment');
        }
    });
    await check('editor acceptance acknowledgment rejects every nonselected pair and stays silent on Android', async () => {
        const local = makeState(0, [], 'ios', configureLocal);
        for (const operation of ['editor-add', 'editor-remove', 'editor-save', 'editor-discard', 'editor-recover']) {
            for (const outcome of ['replayed', 'retained', 'domainSaved', 'settled', '', null])
                assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, outcome))).ok, true);
        }
        for (const operation of ['editor-checkpoint', 'editor-delete', 'editor-save ', 'editor-', '', null])
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(operation, 'confirmed'))).ok, true);
        assert.equal(local.logText, null); assert.deepEqual(local.logOps, []);
        for (const platform of ['android', undefined]) {
            const android = makeState(0, [], platform);
            for (const operation of ['add', 'remove', 'save', 'discard', 'recover'])
                assert.equal((await poll(android, android.MindwtrHost.attachmentDraftAcknowledged(`editor-${operation}`, 'confirmed'))).ok, true);
            assert.equal(android.logText, null); assert.deepEqual(android.logOps, []);
        }
    });
    await check('editor acceptance acknowledgment never fails its caller when the file sink refuses', async () => {
        const local = makeState(0, [], 'ios');
        assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged('editor-add', 'confirmed'))).ok, true);
        const before = local.logText;
        local.logFailure = 'private diagnostics failure';
        for (const operation of ['add', 'remove', 'save', 'discard', 'recover'])
            assert.equal((await poll(local, local.MindwtrHost.attachmentDraftAcknowledged(`editor-${operation}`, 'confirmed'))).ok, true);
        assert.equal(local.logText, before, 'no failed append fabricates a marker or changes the acknowledgment');
        assert(!local.logText.includes('private diagnostics failure'));
    });
    console.log(`Task244: ${cases} binding cases; direct callback branch/readiness/transport and real RN live-reference policy (Node VM, not Mac/native retirement proof)`);
}
const state = makeState(1);
const result = await poll(state, state.MindwtrHost.boot());
assert.equal(result.ok, false);
assert.match(result.error, /Incomplete tasks load/);
assert.equal(state.activationCount, 0);
assert.equal(state.saveCount, 0);
assert.equal(state.createCount, 0);
assert.equal(state.completeCount, 0);
assert.match((await poll(state, state.MindwtrHost.languageSaved('', 'en-US'))).error,
    /Native storage has not been loaded and validated/);

const full = { tasks: [{ id: 'first' }], projects: [], sections: [], areas: [], people: [], settings: {} };
const partial = { ...full, tasks: [] };
// Startup #4: a non-legacy boot reads whole rows first in the activation, whose validated read fails the boot before any save.
const secondRead = makeState(1, [partial]);
const secondResult = await poll(secondRead, secondRead.MindwtrHost.boot());
assert.equal(secondResult.ok, false);
assert.match(secondResult.error, /Incomplete tasks load/);
assert.equal(secondRead.activationCount, 0);
assert.equal(secondRead.saveCount, 0);

const ready = makeState(0);
assert.equal((await poll(ready, ready.MindwtrHost.boot())).ok, true);
// Task202: all six bridge callbacks settle through submit's Promise slots. The
// service's persistence/policy is tested separately; these gates pin transport,
// localized interpolation, normal admission and recovery-safe admission.
{
    const backup = makeState(0, [], 'ios');
    const metadata = { fileName: 'owned.json', lastModified: 1791115200000, appVersion: '1.3.4' };
    const metadataJSON = JSON.stringify(metadata);
    const reference = { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), byteCount: 420 };
    const referenceJSON = JSON.stringify(reference);
    const snapshotName = backup.backupReply.snapshotName;
    const planJSON = backup.backupPrepared.planJSON;
    const input = { requestId: reference.id, mode: 'merge', snapshotName, text: 'owned 日本語 🦉', metadata };
    const gatedCalls = () => [
        () => backup.MindwtrHost.backupDocumentInspect(input.text, metadataJSON),
        () => backup.MindwtrHost.backupDocumentPrepare(JSON.stringify(input)),
        () => backup.MindwtrHost.backupDocumentCommit(referenceJSON, planJSON, snapshotName),
        () => backup.MindwtrHost.backupDocumentOutcome(referenceJSON, planJSON, snapshotName),
    ];
    for (const call of gatedCalls()) assert.match((await poll(backup, call())).error, /^NOT_READY:/, 'no adapter-bound backup work before boot');
    assert.deepEqual(backup.backupInputs, []);
    assert.equal((await poll(backup, backup.MindwtrHost.boot())).ok, true);
    assert(backup.receiptScope.includes('backupDocument'), 'iOS bootstrap retains complete-document receipts');
    const domainBefore = JSON.stringify({ events: backup.events, saves: backup.saveCount, data: backup.fakeData });
    const inspected = await poll(backup, backup.MindwtrHost.backupDocumentInspect(input.text, metadataJSON));
    assert.deepEqual(inspected, { ok: true, value: { valid: true, title: '合并备份', summary: '2 tasks / 1 projects',
        confirmLabel: 'settings.mergeBackupAction', cancelLabel: 'common.cancel', errorTitle: 'settings.backupMobile.invalidBackup', errorMessage: '' } });
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', input.text, metadata, 'json']), 'owned text and parsed metadata pass unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect('UEsDBA==', metadataJSON, 'csv'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', 'UEsDBA==', metadata, 'csv']), 'CSV binary transport and format pass unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect(input.text, metadataJSON, 'json-restore'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', input.text, metadata, 'json-restore']), 'selected JSON replacement action passes unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect('UEsDBA==', metadataJSON, 'todoist'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', 'UEsDBA==', metadata, 'todoist']), 'Todoist binary transport and action pass unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect('UEsDBA==', metadataJSON, 'ticktick'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', 'UEsDBA==', metadata, 'ticktick']), 'TickTick binary transport and action pass unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect('eyJUQVNL', metadataJSON, 'dgt'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', 'eyJUQVNL', metadata, 'dgt']), 'DGT binary JSON transport and action pass unchanged');
    assert.equal((await poll(backup, backup.MindwtrHost.backupDocumentInspect('VHlwZSxOYW1l', metadataJSON, 'omnifocus'))).ok, true);
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['inspect', 'VHlwZSxOYW1l', metadata, 'omnifocus']), 'OmniFocus binary transport and action pass unchanged');
    const beforeInvalidFormat = backup.backupInputs.length;
    assert.match((await poll(backup, backup.MindwtrHost.backupDocumentInspect(input.text, metadataJSON, 'other'))).error, /^INVALID_INPUT:/);
    assert.equal(backup.backupInputs.length, beforeInvalidFormat, 'unsupported format never reaches service');
    assert.deepEqual((await poll(backup, backup.MindwtrHost.backupDocumentResultModel(JSON.stringify(backup.backupReply)))).value,
        { title: '合并备份', message: '2 added / 1 updated', undoLabel: 'settings.undoImport', doneLabel: 'common.done' });
    assert.equal((await poll(backup, backup.MindwtrHost.backupSnapshotRestoreModel(snapshotName))).value.message,
        `Restore ${snapshotName}; later edits are rolled back`);
    assert.deepEqual(await poll(backup, backup.MindwtrHost.backupExportPrepared('json')), { ok: true, value: {} },
        'completed export callback settles through submit\'s Promise slot');
    assert.match(backup.logText, /v1\.3\.5\/ios-backup-export/, 'completed export records its fixed marker');
    assert.equal(JSON.stringify({ events: backup.events, saves: backup.saveCount, data: backup.fakeData }), domainBefore,
        'inspection and localized result/confirmation reads neither flush nor mutate domain state');
    let release;
    backup.backupPrepareHold = new Promise((resolveHeld) => { release = resolveHeld; });
    const preparedID = backup.MindwtrHost.backupDocumentPrepare(JSON.stringify(input));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(backup.MindwtrHost.poll(preparedID), null, 'held service Promise cannot become a false acknowledgment');
    release();
    assert.deepEqual(await poll(backup, preparedID), { ok: true, value: backup.backupPrepared });
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['prepare', true, input]));
    backup.backupPrepareHold = null;
    backup.backupReadinessResult = { ok: false, error: { code: 'NOT_READY', message: 'presentation reload unavailable' } };
    const inputsBeforeRefusal = backup.backupInputs.length;
    for (const call of gatedCalls().slice(0, 2)) assert.match((await poll(backup, call())).error, /^NOT_READY:/);
    assert.equal(backup.backupInputs.length, inputsBeforeRefusal, 'normal readiness failure reaches neither inspection nor preparation');
    const readsBeforeRecovery = backup.backupReadinessChecks;
    assert.deepEqual(await poll(backup, backup.MindwtrHost.backupDocumentCommit(referenceJSON, planJSON, snapshotName)),
        { ok: true, value: backup.backupReply });
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['commit', true, reference, planJSON, snapshotName]));
    backup.persistenceFailure = { message: 'owed save' };
    assert.deepEqual(await poll(backup, backup.MindwtrHost.backupDocumentOutcome(referenceJSON, planJSON, snapshotName)), { ok: true, value: null });
    backup.backupOutcome = backup.backupReply;
    assert.deepEqual(await poll(backup, backup.MindwtrHost.backupDocumentOutcome(referenceJSON, planJSON, snapshotName)), { ok: true, value: backup.backupReply });
    assert.equal(backup.backupInputs.at(-1), JSON.stringify(['outcome', true, reference, planJSON, snapshotName]));
    assert.equal(backup.backupReadinessChecks, readsBeforeRecovery, 'recovery dispatch is independent of mutable presentation readiness');
    assert.equal(JSON.stringify({ events: backup.events, saves: backup.saveCount, data: backup.fakeData }), domainBefore,
        'terminal outcome dispatch adds no flush or document work');
    backup.persistenceFailure = null;
    backup.backupReadinessResult = { ok: true, value: { version: 1 } };
    backup.persistenceStatus = { queued: true };
    assert.match((await poll(backup, backup.MindwtrHost.backupDocumentInspect(input.text, metadataJSON))).error, /^NOT_READY:/);
    backup.persistenceStatus = null;
    for (const field of ['sandbox', 'workspaceTransition']) {
        backup[field] = true;
        const before = backup.backupInputs.length;
        for (const call of gatedCalls()) assert.match((await poll(backup, call())).error, /^NOT_READY:/, `${field} blocks adapter-bound backups`);
        assert.equal(backup.backupInputs.length, before);
        backup[field] = false;
    }
    for (const call of [() => backup.MindwtrHost.backupDocumentInspect(input.text, '{private-text'),
        () => backup.MindwtrHost.backupDocumentPrepare('{private-text'),
        () => backup.MindwtrHost.backupDocumentCommit('{private-text', planJSON, snapshotName),
        () => backup.MindwtrHost.backupDocumentOutcome('{private-text', planJSON, snapshotName),
        () => backup.MindwtrHost.backupDocumentResultModel('{private-text')]) {
        assert.deepEqual(await poll(backup, call()), { ok: false, error: 'INVALID_INPUT: Invalid backup document input' });
    }
}
// Task195: real shared tag-input policy, bounded wrappers and exact raw payload
// transport. Store/receipt/CAS behavior runs in core and real Swift/JSC tests.
{
    const tag195 = makeState('auto');
    assert.equal((await poll(tag195, tag195.MindwtrHost.boot())).ok, true);
    for (const [text, count] of [['', 0], [' \n\t', 0], ['###', 0], ['  ###café 🧭  ', 3], ['x'.repeat(2000), 0]]) {
        assert.deepEqual(await poll(tag195, tag195.MindwtrHost.referenceBulkTagInput(text, count)),
            await poll(tag195, tag195.MindwtrHost.doneBulkTagInput(text, count)));
    }
    for (const [text, count] of [['x'.repeat(2001), 0], ['x', -1], ['x', 0.5], ['x', true], ['x', 10001]]) {
        assert.equal((await poll(tag195, tag195.MindwtrHost.referenceBulkTagInput(text, count))).ok, false);
    }
    const request = { requestId: '19500000-0000-4000-8000-000000000001', taskIds: ['task-cafe\u0301'],
        taskRevisions: { ['task-cafe\u0301']: 'revision195' }, tag: '  ###café 🧭  ', params: { groupBy: 'none' } };
    const envelope = { request, prepared: { version: 1, request, result: { count: 1, changed: true } } };
    assert.deepEqual(await poll(tag195, tag195.MindwtrHost.referenceTasksAddTagPrepare(JSON.stringify(request))),
        { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } });
    for (const [method, phase] of [['referenceTasksAddTagValidate', 'Validate'], ['referenceTasksAddTagCommit', 'Commit'], ['referenceTasksAddTagOutcome', 'Outcome']]) {
        assert.deepEqual(await poll(tag195, tag195.MindwtrHost[method](JSON.stringify(envelope))), { ok: true, value: envelope.prepared.result });
        assert.deepEqual(JSON.parse(tag195.menuInputs.at(-1)), ['referenceTag' + phase, envelope]);
        assert.equal((await poll(tag195, tag195.MindwtrHost[method]('x'.repeat(2000001)))).ok, false);
    }
}
// Task196: Remove tag uses its own exact envelope family and whole-payload bound.
{
    const remove196 = makeState('auto');
    assert.equal((await poll(remove196, remove196.MindwtrHost.boot())).ok, true);
    const tags = ['  ###café 🧭  ', 'cafe\u0301', 'x'.repeat(2001), ...Array.from({length: 101}, (_, i) => 'pick196-' + i)];
    const request = { requestId: '19600000-0000-4000-8000-000000000001', taskIds: ['task-cafe\u0301'],
        taskRevisions: { ['task-cafe\u0301']: 'revision196' }, tags, params: { groupBy: 'none' } };
    const envelope = { request, prepared: { version: 1, request, result: { count: 1, changed: true } } };
    assert.deepEqual(await poll(remove196, remove196.MindwtrHost.referenceTasksRemoveTagPrepare(JSON.stringify(request))),
        { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } });
    assert.deepEqual(JSON.parse(remove196.menuInputs.at(-1)), ['referenceRemoveTagPrepare', request]);
    for (const [method, phase] of [['referenceTasksRemoveTagValidate', 'Validate'], ['referenceTasksRemoveTagCommit', 'Commit'], ['referenceTasksRemoveTagOutcome', 'Outcome']]) {
        assert.deepEqual(await poll(remove196, remove196.MindwtrHost[method](JSON.stringify(envelope))), { ok: true, value: envelope.prepared.result });
        assert.deepEqual(JSON.parse(remove196.menuInputs.at(-1)), ['referenceRemoveTag' + phase, envelope]);
        assert.equal((await poll(remove196, remove196.MindwtrHost[method]('x'.repeat(2000001)))).ok, false);
    }
}
assert.equal(ready.activationCount, 1);
// Startup #4: a non-legacy boot sets the schema up, and the activation's validated read is its first full read. Activation may
// write (core backfills a person per assignee): the store is checked against the database after its save, by id, from core's
// row-version read, which also refreshes the deletion baseline (rowids of rows the save created) under the accepted epoch.
assert.deepEqual(ready.events, ['schema', 'activate', 'load', 'flush', 'baseline']);
{
    // Ids, not counts: a lost row and a duplicated one leave the count equal.
    const lost = makeState(2);
    lost.fakeData = { ...full, tasks: [{ id: 'a' }, { id: 'b' }] };
    lost.rowBaseline = { ids: { tasks: ['a', 'c'], projects: [], sections: [], areas: [], people: [] }, settings: {} };
    assert.match((await poll(lost, lost.MindwtrHost.boot())).error, /Incomplete tasks activation/);
    const twice = makeState(2);
    twice.fakeData = { ...full, tasks: [{ id: 'a' }, { id: 'a' }] };
    twice.rowBaseline = { ids: { tasks: ['a', 'b'], projects: [], sections: [], areas: [], people: [] }, settings: {} };
    assert.match((await poll(twice, twice.MindwtrHost.boot())).error, /Incomplete tasks activation/);
    // Another connection committed since the activation's read: a full validated read instead (today's check).
    const moved = makeState(0);
    moved.rowBaselineNull = true;
    assert.equal((await poll(moved, moved.MindwtrHost.boot())).ok, true);
    assert.deepEqual(moved.events, ['schema', 'activate', 'load', 'flush', 'baseline', 'load']);
    // The settings row is compared with what core maps from it, never with the store: a recovery load that drops ai.apiKey
    // from the store (unsaved) still boots; a row that maps differently does not.
    const stripped = makeState(0);
    stripped.fakeData = { ...full, tasks: [], settings: { ai: { provider: 'openai', apiKey: 'stored' } } };
    stripped.settings = { ai: { provider: 'openai' } };
    assert.equal((await poll(stripped, stripped.MindwtrHost.boot())).ok, true);
    const remapped = makeState(0);
    remapped.fakeData = { ...full, tasks: [], settings: { theme: 'dark' } };
    remapped.rowBaseline = { ids: { tasks: [], projects: [], sections: [], areas: [], people: [] }, settings: { theme: 'light' } };
    assert.match((await poll(remapped, remapped.MindwtrHost.boot())).error, /Incomplete settings load/);
    // Saved filters keep their mapping check: a blank id maps to nothing, so 3 rows mapping to 2 filters fail the boot.
    // The activation loaded 3 (the store's list); then one row's id went blank: the table still counts 3, core now maps 2.
    const blank = makeState(0);
    const three = { savedFilters: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] };
    blank.fakeData = { ...full, tasks: [], settings: three };
    blank.settings = three;
    blank.filterCount = 3;
    blank.rowBaseline = { ids: { tasks: [], projects: [], sections: [], areas: [], people: [] }, settings: { savedFilters: [{ id: 'f1' }, { id: 'f2' }] } };
    assert.match((await poll(blank, blank.MindwtrHost.boot())).error, /Incomplete saved filters load/);
}
// Replay tokens and durable receipts: iOS keeps tokens optional but loads only App lock's exact receipts; Android's
// journaled boot requires tokens and loads all receipts before the validated load, activation, and replay.
assert.equal(ready.replayTokens, 'optional');
assert.equal(ready.receiptsLoadedAt, 0);
assert.deepEqual([...ready.receiptScope], ['appLock', 'notificationSetting', 'deviceCalendarSetting', 'calendarSubscriptionSetting', 'calendarSubscriptionAdd', 'reminderComplete', 'reminderSnooze', 'taskCompletion', 'taskCompletionUndo', 'archivedTaskRestore', 'archivedTasksRestore', 'doneTasksMove', 'doneTasksAddTag', 'doneTasksRemoveTag', 'archivedTasksDelete', 'archivedTasksDeleteUndo', 'doneTasksDelete', 'doneTasksDeleteUndo', 'referenceTasksDelete', 'referenceTasksDeleteUndo', 'referenceTasksMove', 'referenceTasksAddTag', 'referenceTasksRemoveTag', 'preparedProjectLifecycle', 'preparedTaskDelete', 'preparedProjectDelete', 'preparedTaskDeleteUndo', 'doneTaskStatus', 'referenceTaskNext', 'referenceTaskStatus', 'referenceTaskCompletion', 'referenceTaskCompletionUndo', 'referenceTaskBackdate', 'referenceTaskDestination', 'referenceProjectNextAction', 'doneTaskCompletedAt', 'archiveTaskCompletedAt', 'data', 'backupDocument'], 'the VM array, compared in this realm');
{
    const journaled = makeState(0);
    assert.equal((await poll(journaled, journaled.MindwtrHost.boot('', '', 'journaled'))).ok, true);
    assert.equal(journaled.replayTokens, 'required');
    assert.equal(journaled.receiptsLoadedAt, 0);
    assert.equal(journaled.receiptScope, null);
}
// A revision a host leaves out ("") is none: core requires one only from a journaling host.
for (const [method, call] of [['complete', 'completeTask({ id, taskRevision: taskRevision || undefined })'],
    ['taskFocus', 'setTaskFocus({ id, focused, taskRevision: taskRevision || undefined })'],
    ['projectFocus', 'setProjectFocus({ id, focused, projectRevision: projectRevision || undefined })']]) {
    assert(hostEntry.includes(`contract.${call}`), `${method} sends no revision for ""`);
}
assert.deepEqual(await poll(ready, ready.MindwtrHost.pruneReceipts()), { ok: true, value: { pruned: 3 } });
// The capture popup: every call passes Kotlin's JSON to core unchanged; the snapshot comes wrapped, null in sandbox mode.
{
    const draft = { text: 'Call @phone', options: { addAnother: false } };
    const submitInput = { ...draft, captureId: '123', openAfterSave: false };
    assert.equal((await poll(ready, ready.MindwtrHost.captureSubmit(JSON.stringify(submitInput)))).value.kind, 'saved');
    assert.equal(ready.createCount, 1);
    assert.equal((await poll(ready, ready.MindwtrHost.captureOpen())).ok, true);
    assert.deepEqual((await poll(ready, ready.MindwtrHost.captureView(JSON.stringify({ ...draft, picker: { kind: 'project', query: 'h' } })))).value.options, draft.options);
    assert.equal((await poll(ready, ready.MindwtrHost.captureEdit(JSON.stringify({ ...draft, edit: { type: 'toggleFocus' } })))).value.notice, null);
    assert.deepEqual((await poll(ready, ready.MindwtrHost.captureSnapshot())).value,
        { snapshot: { fileName: 'data.2026-09-24T10-00-00.000.snapshot.json', contents: '{}' } });
    ready.snapshotResult = { ok: true, value: null };
    assert.deepEqual((await poll(ready, ready.MindwtrHost.captureSnapshot())).value, { snapshot: null });
    const linesInput = { text: 'a\nb', options: draft.options, captureIds: ['1', '2'], snapshotFileName: null };
    assert.deepEqual((await poll(ready, ready.MindwtrHost.captureLines(JSON.stringify(linesInput)))).value, { kind: 'saved', taskIds: ['1', '2'] });
    const pickerInput = { picker: 'project', query: 'Home', ...draft, requestId: '9' };
    assert.equal((await poll(ready, ready.MindwtrHost.capturePicker(JSON.stringify(pickerInput)))).value.created, true);
    assert.deepEqual(ready.captureInputs, [JSON.stringify(['submit', submitInput]), 'open', JSON.stringify(['view', { ...draft, picker: { kind: 'project', query: 'h' } }]),
        JSON.stringify(['edit', { ...draft, edit: { type: 'toggleFocus' } }]), 'snapshot', 'snapshot', JSON.stringify(['lines', linesInput]), JSON.stringify(['picker', pickerInput])]);
    ready.captureInputs.length = 0;
}
// The capture screen: its reads are Menu reads, its Save and Create tasks journaled task commands; each passes Kotlin's JSON unchanged.
{
    const params = { initialValue: 'Buy%20milk', project: 'Home' };
    const draft = { text: 'Buy milk', description: '', showHelp: false, suggestion: null, applied: { tags: [] }, failed: false };
    const reads = [['captureModalOpen', { params }], ['captureModalView', { params, draft }], ['captureModalEdit', { params, draft, edit: { type: 'toggleHelp' } }],
        ['captureModalDiscard', { params }]];
    for (const [name, input] of reads) assert.equal((await poll(ready, ready.MindwtrHost.menuRead(name, JSON.stringify(input)))).ok, true, `menuRead ${name}`);
    const submitInput = { params, draft, captureId: '5', openAfterSave: true };
    assert.equal((await poll(ready, ready.MindwtrHost.captureModalSubmit(JSON.stringify(submitInput)))).value.taskId, '5');
    const linesInput = { params, draft: { ...draft, text: 'a\nb' }, captureIds: ['6', '7'] };
    assert.deepEqual((await poll(ready, ready.MindwtrHost.captureModalLines(JSON.stringify(linesInput)))).value.taskIds, ['6', '7']);
    assert.deepEqual(ready.captureInputs, [JSON.stringify(['modalOpen', reads[0][1]]), JSON.stringify(['modalView', reads[1][1]]), JSON.stringify(['modalEdit', reads[2][1]]),
        JSON.stringify(['modalDiscard', reads[3][1]]),
        JSON.stringify(['modalSubmit', submitInput]), JSON.stringify(['modalLines', linesInput])]);
    ready.captureInputs.length = 0;
}
// The queue drain: core's ingestPendingCaptures lists, reads and deletes the app's files/pending-captures through Kotlin's file
// calls, and keeps its last-applied record under RN's RKStorage key; the request UUID is the journal's. A Kotlin failure (a
// marked string) reaches core as a thrown error, so core keeps that file; a missing folder lists as null.
{
    const key = 'mindwtr:pending-captures:last-applied:v1';
    ready.queueFiles = { 'a.json': '{"id":"1","title":"Grüße ✓ 😀"}' };
    ready.kv = { [key]: '{}' };
    assert.deepEqual(await poll(ready, ready.MindwtrHost.ingest('r-1')), { ok: true, value: { ingested: 1 } });
    assert.deepEqual(ready.fileCalls, ['list files/pending-captures', 'read files/pending-captures/a.json', `kvGet ${key}`,
        `kvSet ${key} {"t":{"tapMs":1,"id":"c","at":2}}`, 'delete files/pending-captures/a.json']);
    assert.deepEqual(JSON.parse(ready.ingestInputs.pop()), ['r-1', ['a.json'], ['{"id":"1","title":"Grüße ✓ 😀"}'], '{}']);
    ready.deleteResult = '!MindwtrNativeError:Cannot delete files/pending-captures/a.json';
    assert.deepEqual(await poll(ready, ready.MindwtrHost.ingest('r-2')), { ok: false, error: 'Cannot delete files/pending-captures/a.json' });
    ready.deleteResult = null;
    ready.queueFiles = null;
    ready.kv = {};
    assert.deepEqual(await poll(ready, ready.MindwtrHost.ingest('r-3')), { ok: true, value: { ingested: 0 } });
    assert.deepEqual(JSON.parse(ready.ingestInputs.pop()), ['r-3', null, [], null]);
    // A trigger: core's notification as RN's alarm library's details with the channel's name; none for a deactivation or in sandbox mode.
    const trigger = { action: 'activate', context: '@home' };
    assert.deepEqual(await poll(ready, ready.MindwtrHost.contextAutomation(JSON.stringify(trigger))), { ok: true, value: { notification: {
        title: '@home next action', message: 'Call', channel: 'mindwtr_reminders_v2', data: { kind: 'context-automation', context: '@home' }, channelName: 'Mindwtr reminders' } } });
    assert.deepEqual(JSON.parse(ready.ingestInputs.pop()), ['context', trigger]);
    assert.deepEqual(await poll(ready, ready.MindwtrHost.contextAutomation(JSON.stringify({ ...trigger, action: 'deactivate' }))), { ok: true, value: { notification: null } });
    ready.sandbox = true;
    assert.deepEqual(await poll(ready, ready.MindwtrHost.contextAutomation(JSON.stringify(trigger))), { ok: true, value: { notification: null } });
    ready.sandbox = false;
    ready.ingestInputs.length = 0;
    ready.fileCalls.length = 0;
}
// update passes Kotlin's { id, base, patch } to core unchanged, and a refusal keeps its code prefix.
const updateInput = JSON.stringify({ id: 't', base: { title: 'a', dueDate: null }, patch: { title: 'b', dueDate: '2026-09-15' } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.update(updateInput)), { ok: true, value: { id: 't', changed: true } });
assert.deepEqual(ready.updateInputs, [updateInput]);
ready.updateResult = { ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: title' } };
assert.deepEqual(await poll(ready, ready.MindwtrHost.update(updateInput)),
    { ok: false, error: 'STALE_REVISION: Task changed while editing: title' });
assert.deepEqual(await poll(ready, ready.MindwtrHost.editorModel('t')), { ok: true, value: { version: 1, id: 't' } });
// The View tab and the checklist edit pass Kotlin's input to core unchanged; Reset checklist is a command (no requireSaved).
assert.deepEqual(await poll(ready, ready.MindwtrHost.taskView('{"id":"t"}')),
    { ok: true, value: { version: 1, id: 't', readOnly: false, rows: [], checklistBase: [{ id: 'c', title: 'Milk', isCompleted: true }] } });
const checklistInput = { id: 't', draft: { title: 'a' }, checklist: [{ id: 'c', title: 'Milk', isCompleted: true }], edit: { kind: 'toggle', index: 0 } };
assert.deepEqual((await poll(ready, ready.MindwtrHost.editChecklist(JSON.stringify(checklistInput)))).value.checklist, checklistInput.checklist);
assert.deepEqual(await poll(ready, ready.MindwtrHost.editorSuggestions('t', 'contexts', 'home', 4)),
    { ok: true, value: { draftValue: '@home', matches: [], quick: [] } });
const editInput = { id: 't', draft: { title: 'a', dueDate: '' }, edit: { type: 'pickDate', field: 'dueDate', date: '2026-09-17' } };
assert.deepEqual(await poll(ready, ready.MindwtrHost.editDraft(JSON.stringify(editInput))), { ok: true, value: { version: 1, id: 't', draft: editInput.draft } });
assert.deepEqual(ready.editorInputs, ['{"id":"t"}', '["view",{"id":"t"}]', JSON.stringify(['checklist', checklistInput]), '["suggest",{"id":"t","field":"contexts","query":"home","limit":4}]',
    JSON.stringify(['edit', editInput])]);
// saveDraft passes Kotlin's { id, base, patch } to core's saveTaskDraft unchanged, and a refusal keeps its code prefix.
const draftInput = JSON.stringify({ id: 't', base: { title: 'a', dueDate: '', relativeStartOffset: null }, patch: { title: 'b', dueDate: '2026-09-15T14:05', relativeStartOffset: null } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.saveDraft(draftInput)), { ok: true, value: { id: 't', draft: { title: 'b' } } });
ready.saveDraftResult = { ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: title' } };
assert.deepEqual(await poll(ready, ready.MindwtrHost.saveDraft(draftInput)), { ok: false, error: 'STALE_REVISION: Task changed while editing: title' });
assert.deepEqual(ready.updateInputs.slice(-2), [JSON.stringify(['draft', JSON.parse(draftInput)]), JSON.stringify(['draft', JSON.parse(draftInput)])]);
ready.updateInputs.length = 2;
ready.saveDraftResult = { ok: true, value: { id: 't', draft: { title: 'b' } } };
// Focus queries pass Kotlin's arguments to core unchanged; a stale window keeps its code prefix for Kotlin.
assert.deepEqual(await poll(ready, ready.MindwtrHost.focus(50)), { ok: true, value: { version: 1, revision: 'f', sections: [] } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.focusWindow('next', 50, 50, 'f')),
    { ok: false, error: 'STALE_REVISION: Focus changed; restart paging' });
assert.deepEqual(ready.focusInputs, ['{"limit":50}', '{"key":"next","offset":50,"limit":50,"revision":"f"}']);
// With Focus's control state (and a control's edit), both pass them to core as parsed JSON.
await poll(ready, ready.MindwtrHost.focus(50, '{"sortBy":"due"}', '{"type":"sort","sortBy":"title"}'));
await poll(ready, ready.MindwtrHost.focusWindow('next', 50, 50, 'f', '{"sortBy":"due"}'));
assert.deepEqual(ready.focusInputs.slice(2), ['{"limit":50,"controls":{"sortBy":"due"},"controlEdit":{"type":"sort","sortBy":"title"}}',
    '{"key":"next","offset":50,"limit":50,"revision":"f","controls":{"sortBy":"due"}}']);
// A command is accepted while a read is still in flight: the host neither serializes nor refuses them.
{
    const completesBefore = ready.completeCount;
    const read = ready.MindwtrHost.focus(50);
    const command = ready.MindwtrHost.complete('t');
    assert.equal((await poll(ready, command)).ok, true);
    assert.equal(ready.completeCount, completesBefore + 1);
    assert.equal((await poll(ready, read)).ok, true);
    ready.focusInputs.pop();
}
// Language: "" is no stored language; the keys pass to core unchanged.
assert.deepEqual(await poll(ready, ready.MindwtrHost.language('', 'en-US')), { ok: true, value: { language: 'en' } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.language('zh', 'en-US')), { ok: true, value: { language: 'zh' } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.strings('["tab.inbox"]')),
    { ok: true, value: { language: 'zh', strings: { 'tab.inbox': '收集箱' }, missing: [] } });
assert.deepEqual(ready.languageInputs, ['{"storedLanguage":null,"systemLocale":"en-US"}', '{"storedLanguage":"zh","systemLocale":"en-US"}',
    '{"keys":["tab.inbox"]}']);
// The new iOS-only route reads the settled Settings row. The two-arg Android route above keeps its device-key semantics.
{
    const savedLanguage = async (stored = 'zh', system = 'en-US') => await poll(ready, ready.MindwtrHost.languageSaved(stored, system));
    assert.deepEqual(await savedLanguage(), { ok: true, value: { language: 'zh', deviceWrites: [] } });
    ready.fakeData.settings = { language: 'fa' };
    ready.settings = { language: 'fa' };
    assert.deepEqual(await savedLanguage(), { ok: true, value: { language: 'fa',
        deviceWrites: [{ key: 'mindwtr-language', value: 'fa' }] } });
    assert.deepEqual(await poll(ready, ready.MindwtrHost.language('zh', 'en-US')),
        { ok: true, value: { language: 'zh' } }, 'legacy Android route ignores synced preference');
    ready.settings = { language: 'de' };
    assert.deepEqual((await savedLanguage()).value, { language: 'fa', deviceWrites: [] },
        'mismatched optimistic memory cannot authorize a mirror');
    ready.settings = { language: 'fa' };
    ready.persistenceStatus = { generation: 1, queued: true, inFlight: false, immediate: false, retrying: false, failed: false };
    assert.deepEqual((await savedLanguage()).value, { language: 'zh', deviceWrites: [] });
    ready.persistenceStatus = { generation: 1, queued: false, inFlight: false, immediate: false, retrying: false, failed: true };
    assert.deepEqual((await savedLanguage()).value, { language: 'zh', deviceWrites: [] });
    ready.persistenceStatus = null;
    ready.afterLanguage = () => { ready.persistenceStatus = { generation: 2, queued: false, inFlight: false,
        immediate: false, retrying: false, failed: false }; };
    assert.deepEqual((await savedLanguage()).value, { language: 'fa', deviceWrites: [] },
        'an intervening generation cannot authorize a mirror');
    ready.afterLanguage = null;
    ready.persistenceStatus = null;
    for (const raw of ['constructor', '__proto__', null, { code: 'fa' }]) {
        ready.fakeData.settings = { language: raw };
        ready.settings = { language: raw };
        assert.deepEqual((await savedLanguage()).value, { language: 'zh', deviceWrites: [] });
    }
    ready.fakeData.settings = [];
    assert.match((await savedLanguage()).error, /Invalid settings load/);
    ready.fakeData.settings = { language: 'fa' };
    ready.settings = { language: 'fa' };
    ready.settingsReadFailure = true;
    assert.match((await savedLanguage()).error, /settings storage unavailable/);
    ready.settingsReadFailure = false;
    assert.equal((await savedLanguage()).value.deviceWrites[0].value, 'fa', 'a settled Settings read may retry');
    assert.match((await poll(ready, ready.MindwtrHost.languageSaved('x'.repeat(501), 'en-US'))).error,
        /INVALID_INPUT/);
    ready.settings = undefined;
    ready.fakeData.settings = {};
}
// Theme: the synced setting wins over RN's device-local choice, then the system; core classifies it and sends its hues.
{
    const theme = async (stored) => (await poll(ready, ready.MindwtrHost.theme(stored))).value;
    assert.deepEqual(await theme(''), { mode: 'system', deviceWrites: [], preset: 'default', presets: { light: 'default', dark: 'default' }, material: false, scheme: null,
        status: { light: { done: { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' } }, dark: { done: { bg: '#4ADE8026', text: '#4ADE80', border: '#4ADE80' } } }, priority: { urgent: '#dc2626', low: '#3b82f6' } });
    assert.deepEqual(await theme('material3-light'), { mode: 'material3-light', deviceWrites: [], preset: 'default', presets: { light: 'default', dark: 'default' }, material: true, scheme: 'light',
        status: { light: { done: { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' } }, dark: { done: { bg: '#4ADE8026', text: '#4ADE80', border: '#4ADE80' } } }, priority: { urgent: '#dc2626', low: '#3b82f6' } });
    ready.settings = { theme: 'nord' };
    ready.fakeData.settings = { theme: 'nord' };
    assert.deepEqual(await theme('material3-light'), { mode: 'nord', deviceWrites: [
        { key: '@mindwtr_theme', value: 'nord' }, { key: '@mindwtr_theme_style', value: 'default' }],
    preset: 'nord', presets: { light: 'nord', dark: 'nord' }, material: false, scheme: 'dark',
        status: { light: { done: { bg: '#A3BE8C26', text: '#A3BE8C', border: '#A3BE8C' } }, dark: { done: { bg: '#A3BE8C26', text: '#A3BE8C', border: '#A3BE8C' } } }, priority: { urgent: '#dc2626', low: '#3b82f6' } });
    ready.fakeData.settings = { theme: 'constructor' };
    ready.settings = { theme: 'constructor' };
    assert.deepEqual((await theme('')).deviceWrites, []);
    ready.fakeData.settings = { theme: 'nord' };
    ready.settings = { theme: 'nord' };
    ready.persistenceStatus = { generation: 1, queued: true, inFlight: false, immediate: false, retrying: false, failed: false };
    assert.deepEqual((await theme('')).deviceWrites, [], 'queued settings never authorize an optimistic mirror');
    ready.persistenceStatus = { generation: 1, queued: false, inFlight: false, immediate: false, retrying: false, failed: true };
    assert.deepEqual((await theme('')).deviceWrites, [], 'failed settings never authorize an optimistic mirror');
    ready.persistenceStatus = null;
    ready.fakeData.settings = { theme: 'dark' };
    assert.deepEqual((await theme('')).deviceWrites, [], 'a memory/disk mismatch never authorizes a mirror');
    ready.fakeData.settings = { theme: 'nord' };
    ready.settingsReadFailure = true;
    assert.match((await poll(ready, ready.MindwtrHost.theme(''))).error, /settings storage unavailable/);
    ready.settingsReadFailure = false;
    assert.equal((await theme('')).deviceWrites[0].value, 'nord', 'a settled Settings read may retry');
    ready.settings = undefined;
}
// Projects pass Kotlin's arguments to core unchanged; the first window has no revision, and a stale one keeps its code prefix.
assert.deepEqual(await poll(ready, ready.MindwtrHost.projects()),
    { ok: true, value: { version: 1, revision: 'p', active: [], deferred: [], archived: [] } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.projectDetail('p1', 50, 50, 'r')),
    { ok: false, error: 'STALE_REVISION: Project changed; restart paging from offset zero' });
ready.projectDetailResult = { ok: true, value: { version: 1, revision: 'r', projectId: 'p1', readOnly: false, total: 0, items: [] } };
assert.equal((await poll(ready, ready.MindwtrHost.projectDetail('p1', 0, 50, ''))).ok, true);
assert.deepEqual(ready.projectInputs, ['projects', '{"projectId":"p1","offset":50,"limit":50,"revision":"r"}', '{"projectId":"p1","offset":0,"limit":50}']);
// The new commands pass Kotlin's arguments to core unchanged: the star's target and the row's revision, the request UUID, "" as no area, a `next` selection.
assert.deepEqual(await poll(ready, ready.MindwtrHost.taskFocus('t', true, 'rt')), { ok: true, value: { blocked: 'Max 5 focus items.', blockedTitle: 'Focus' } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.projectFocus('p', false, 'rp')), { ok: true, value: { blocked: '' } });
assert.deepEqual(await poll(ready, ready.MindwtrHost.createProject('New', '', '123')), { ok: true, value: { id: 'p' } });
assert.equal((await poll(ready, ready.MindwtrHost.areaFilter())).value.label, 'All');
assert.equal((await poll(ready, ready.MindwtrHost.setAreaFilter('{"included":["a"],"excluded":[]}'))).ok, true);
assert.deepEqual(ready.newInputs, ['["taskFocus",{"id":"t","focused":true,"taskRevision":"rt"}]', '["projectFocus",{"id":"p","focused":false,"projectRevision":"rp"}]',
    '["createProject",{"title":"New","areaId":null,"requestId":"123"}]', 'areaFilter', '["setAreaFilter",{"included":["a"],"excluded":[]}]']);
ready.taskFocusResult = { ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } };
assert.deepEqual(await poll(ready, ready.MindwtrHost.taskFocus('t', true)), { ok: false, error: 'SAVE_FAILED: disk full' });
ready.newInputs.length = 0;
// Search and Process Inbox pass Kotlin's JSON to core unchanged; a failed answer keeps its code prefix; end answers an object.
{
    const searchInput = { query: ' milk ', filters: { scope: 'all' }, limit: 50 };
    const stepInput = { sessionId: 'x', taskId: 't', step: 'actionable', edit: { type: 'set', field: 'title', value: 'a' } };
    const commitInput = { sessionId: 'x', taskId: 't', step: 'actionable', decision: { choice: 'trash' }, requestId: 'r' };
    assert.equal((await poll(ready, ready.MindwtrHost.search(JSON.stringify(searchInput)))).value.query, 'milk');
    assert.equal((await poll(ready, ready.MindwtrHost.saveSearch('{"query":"milk","name":"Milk","requestId":"r"}'))).ok, true);
    assert.equal((await poll(ready, ready.MindwtrHost.inboxStart('quick'))).value.sessionId, 'x');
    assert.equal((await poll(ready, ready.MindwtrHost.inboxStep(JSON.stringify(stepInput)))).ok, true);
    assert.deepEqual(await poll(ready, ready.MindwtrHost.inboxCommit(JSON.stringify(commitInput))), { ok: false, error: 'SAVE_FAILED: disk full' });
    assert.equal((await poll(ready, ready.MindwtrHost.inboxSkip('{"sessionId":"x","taskId":"t","requestId":"s"}'))).value.view, null);
    assert.deepEqual(await poll(ready, ready.MindwtrHost.inboxEnd('x')), { ok: true, value: {} });
    assert.deepEqual(ready.newInputs, [JSON.stringify(['search', searchInput]), '["saveSearch",{"query":"milk","name":"Milk","requestId":"r"}]',
        '["inboxStart",{"mode":"quick"}]', JSON.stringify(['inboxStep', stepInput]), JSON.stringify(['inboxCommit', commitInput]),
        '["inboxSkip",{"sessionId":"x","taskId":"t","requestId":"s"}]', '["inboxEnd",{"sessionId":"x"}]']);
    // The screen's first read sends no filters: the host fills in core's defaults.
    await poll(ready, ready.MindwtrHost.search('{"query":"","filters":null,"limit":50}'));
    assert.deepEqual(ready.newInputs.slice(-1), [JSON.stringify(['search', { query: '', filters: { scope: 'all' }, limit: 50 }])]);
    ready.newInputs.length = 0;
}
// The Menu tab's reads and commands pass Kotlin's JSON to core unchanged; a refusal keeps its code prefix; an unknown name is refused.
{
    const somedayInput = { sortBy: 'title', filters: { tokens: ['#home'] }, filterEdit: { type: 'toggleToken', value: '#home' }, offset: 0, limit: 50 };
    const moveInput = { taskIds: ['a', 'b'], sectionId: null, requestId: 'r' };
    assert.equal((await poll(ready, ready.MindwtrHost.menuRead('more', '{}'))).value.revision, 'm');
    assert.equal((await poll(ready, ready.MindwtrHost.menuRead('waiting', '{"person":"","offset":0,"limit":50}'))).ok, true);
    assert.deepEqual(await poll(ready, ready.MindwtrHost.menuRead('someday', JSON.stringify(somedayInput))),
        { ok: false, error: 'STALE_REVISION: Someday changed; restart paging from offset zero' });
    assert.equal((await poll(ready, ready.MindwtrHost.menuRead('archive', '{"offset":0,"limit":50}'))).ok, true);
    assert.deepEqual(await poll(ready, ready.MindwtrHost.menuCommand('somedayMove', JSON.stringify(moveInput))), { ok: false, error: 'SAVE_FAILED: disk full' });
    assert.equal((await poll(ready, ready.MindwtrHost.menuCommand('somedayTask', '{"title":"t","sectionId":null,"captureId":"c"}'))).value.id, 'c');
    assert.match((await poll(ready, ready.MindwtrHost.menuRead('nope', '{}'))).error, /^INVALID_INPUT/);
    assert.match((await poll(ready, ready.MindwtrHost.menuCommand('nope', '{}'))).error, /^INVALID_INPUT/);
    assert.deepEqual(ready.menuInputs, ['more', JSON.stringify(['waiting', { person: '', offset: 0, limit: 50 }]), JSON.stringify(['someday', somedayInput]),
        JSON.stringify(['archive', { offset: 0, limit: 50 }]), JSON.stringify(['somedayMove', moveInput]),
        JSON.stringify(['somedayTask', { title: 't', sectionId: null, captureId: 'c' }])]);
    ready.menuInputs.length = 0;
}
// Pass 7: Contexts, Trash, Review and the reviews pass Kotlin's JSON to core unchanged; a failed save keeps its code prefix.
{
    const reads = [['contexts', { tokens: ['@home'], matchMode: 'all', searchQuery: '', selectedIds: [], offset: 0, limit: 50 }],
        ['trash', { selected: { taskIds: [], projectIds: [] }, offset: 0, limit: 50 }],
        ['review', { scope: 'due', selectedIds: [], expansionEdit: { type: 'cycle' }, offset: 0, limit: 50 }],
        ['weekly', { checkpoint: null, expandedProjectId: null, offset: 0, limit: 50 }],
        ['weeklyList', { checkpoint: 'c', expandedProjectId: null, list: 'contextTasks', key: '@home', offset: 100, limit: 100, revision: 'w' }],
        ['daily', { checkpoint: null, offset: 0, limit: 50 }]];
    for (const [name, input] of reads) assert.equal((await poll(ready, ready.MindwtrHost.menuRead(name, JSON.stringify(input)))).ok, true, `menuRead ${name}`);
    const commands = [['contextsAction', { requestId: 'r1', action: { type: 'trashTask', taskId: 't' } }],
        ['trashAction', { requestId: 'r2', action: { type: 'emptyTrash', revision: 'd' } }],
        ['reviewTask', { requestId: 'r3', action: { type: 'addProjectTask', projectId: 'p', title: 'x' } }]];
    for (const [name, input] of commands) assert.equal((await poll(ready, ready.MindwtrHost.menuCommand(name, JSON.stringify(input)))).ok, true, `menuCommand ${name}`);
    const mark = { requestId: 'r4', action: { type: 'markReviewedTasks', taskIds: ['t'] } };
    assert.deepEqual(await poll(ready, ready.MindwtrHost.menuCommand('reviewAction', JSON.stringify(mark))), { ok: false, error: 'SAVE_FAILED: disk full' });
    assert.deepEqual(ready.menuInputs, [...reads.map(([name, input]) => JSON.stringify([name, input])),
        ...commands.map(([name, input]) => JSON.stringify([name === 'reviewTask' ? 'reviewAction' : name, input])), JSON.stringify(['reviewAction', mark])]);
    ready.menuInputs.length = 0;
}
ready.persistenceFailure = { message: 'disk full' };
// A blocked read keeps the SAVE_FAILED code and never quotes the store's failure text.
const readRefusal = { ok: false, error: 'SAVE_FAILED: Previous changes could not be saved; retry before continuing' };
const queriesBeforeFailure = ready.queryCount;
const blockedRefresh = await poll(ready, ready.MindwtrHost.window(0, 50, ''));
assert.equal(blockedRefresh.ok, false);
assert.match(blockedRefresh.error, /SAVE_FAILED/);
assert.equal(ready.queryCount, queriesBeforeFailure);
// The editor cannot load unsaved in-memory values as if they were stored.
for (const blocked of [ready.MindwtrHost.editorModel('t'), ready.MindwtrHost.taskView('{"id":"t"}'), ready.MindwtrHost.editChecklist(JSON.stringify(checklistInput)),
    ready.MindwtrHost.editorSuggestions('t', 'tags', 'x', 4), ready.MindwtrHost.editDraft(JSON.stringify(editInput))]) {
    assert.deepEqual(await poll(ready, blocked), readRefusal);
}
assert.equal(ready.editorInputs.length, 5);
// Focus cannot show unsaved in-memory values as stored either.
for (const blocked of [ready.MindwtrHost.focus(50), ready.MindwtrHost.focusWindow('next', 0, 50, 'f')]) {
    assert.deepEqual(await poll(ready, blocked), readRefusal);
}
assert.equal(ready.focusInputs.length, 4);
// Commands never wait on requireSaved: the exact retry of a failed command must reach core, which retries the save.
const commandsBefore = ready.completeCount + ready.createCount + ready.updateInputs.length;
assert.equal((await poll(ready, ready.MindwtrHost.complete('t'))).ok, true);
assert.equal((await poll(ready, ready.MindwtrHost.captureSubmit('{"text":"Retry","options":{},"captureId":"123"}'))).ok, true);
// The popup's reads wait for the retry; its commands (a capture, several lines, a picker create) reach core so the retry can save.
for (const blocked of [ready.MindwtrHost.captureOpen(), ready.MindwtrHost.captureView('{"text":"a","options":{}}'), ready.MindwtrHost.captureEdit('{"text":"a","options":{},"edit":{}}')]) {
    assert.deepEqual(await poll(ready, blocked), readRefusal);
}
for (const command of [ready.MindwtrHost.captureLines('{"text":"a\\nb","options":{},"captureIds":["1","2"],"snapshotFileName":null}'),
    ready.MindwtrHost.capturePicker('{"picker":"area","query":"x","text":"","options":{},"requestId":"9"}')]) {
    assert.equal((await poll(ready, command)).ok, true);
}
ready.updateResult = { ok: true, value: { id: 't', changed: false } };
assert.equal((await poll(ready, ready.MindwtrHost.update(updateInput))).ok, true);
assert.equal((await poll(ready, ready.MindwtrHost.saveDraft(draftInput))).ok, true);
assert.equal(ready.completeCount + ready.createCount + ready.updateInputs.length, commandsBefore + 4);
// Projects cannot show unsaved in-memory values as stored either; labels still load.
for (const blocked of [ready.MindwtrHost.projects(), ready.MindwtrHost.projectDetail('p1', 0, 50, '')]) {
    assert.deepEqual(await poll(ready, blocked), readRefusal);
}
assert.equal(ready.projectInputs.length, 3);
// The area filter is a read: it waits for the retry. Its commands, like every command, reach core so the retry can save.
assert.deepEqual(await poll(ready, ready.MindwtrHost.areaFilter()), readRefusal);
ready.taskFocusResult = { ok: true, value: { id: 't', focused: true } };
for (const command of [ready.MindwtrHost.taskFocus('t', true), ready.MindwtrHost.projectFocus('p', true),
    ready.MindwtrHost.createProject('New', 'a', '123'), ready.MindwtrHost.setAreaFilter('{"included":[],"excluded":[]}')]) {
    assert.equal((await poll(ready, command)).ok, true);
}
assert.equal(ready.newInputs.length, 4);
// Search and Process Inbox reads wait for the retry; their commands reach core so the retry can save.
for (const blocked of [ready.MindwtrHost.search('{"query":"a","filters":{},"limit":50}'), ready.MindwtrHost.inboxStart('guided'),
    ready.MindwtrHost.inboxStep('{"sessionId":"x","taskId":"t","step":"actionable"}')]) {
    assert.deepEqual(await poll(ready, blocked), readRefusal);
}
assert.equal(ready.newInputs.length, 4);
ready.inboxCommitResult = { ok: true, value: { view: null, notice: null, toast: null } };
for (const command of [ready.MindwtrHost.saveSearch('{"query":"a","requestId":"r"}'),
    ready.MindwtrHost.inboxCommit('{"sessionId":"x","taskId":"t","step":"actionable","decision":{"choice":"trash"},"requestId":"r"}'),
    ready.MindwtrHost.inboxSkip('{"sessionId":"x","taskId":"t","requestId":"s"}')]) {
    assert.equal((await poll(ready, command)).ok, true);
}
assert.equal(ready.newInputs.length, 7);
// Menu screen reads wait for the retry; the More sheet's tiles (navigation) do not, so Menu never opens empty;
// menu commands reach core so the retry can save.
assert.deepEqual(await poll(ready, ready.MindwtrHost.menuRead('archive', '{"offset":0,"limit":50}')), readRefusal);
assert.equal(ready.menuInputs.length, 0);
assert.equal((await poll(ready, ready.MindwtrHost.menuRead('more', '{}'))).ok, true);
assert.equal(ready.menuInputs.length, 1);
assert.equal((await poll(ready, ready.MindwtrHost.menuCommand('archiveAction', '{"requestId":"r","action":{"type":"moveToInbox","taskId":"t"}}'))).ok, true);
assert.equal(ready.menuInputs.length, 2);
assert.equal((await poll(ready, ready.MindwtrHost.language('', 'zh-CN'))).ok, true);
assert.equal((await poll(ready, ready.MindwtrHost.strings('["tab.inbox"]'))).ok, true);
// The RN legacy import runs after the validated load and before activation. RN state changes only
// after the saved import is read back, and a failed RN state change never fails the boot.
const bootBody = hostEntry.slice(hostEntry.indexOf('const boot = '), hostEntry.indexOf('globalThis.MindwtrHost ='));
const bootOrder = ['await adapter.getData();', 'await importLegacyJson(adapter,', 'await activateAndVerify(adapter, recoveryLoad)'].map((text) => bootBody.indexOf(text));
assert(bootOrder.every((index, i) => index > (i ? bootOrder[i - 1] : -1)), `boot order ${bootOrder}`);
assert.match(hostEntry, /boot\(legacyState: string, legacyBackup: string, writeJournal = ''\): string \{\s*return boot\(legacyState, legacyBackup, false, writeJournal === 'journaled'\);/);
const importBody = hostEntry.slice(hostEntry.indexOf('const importLegacyJson'), hostEntry.indexOf('// After a failed save'));
const importOrder = ['adapter.latestData', 'planLegacyJsonImport(', 'legacyImportMismatch(plan.merged, loaded)', 'await adapter.saveData(plan.merged)',
    'legacyImportMismatch(plan.merged, await adapter.getData())', 'Legacy import not confirmed', 'native().rnStateCommit(',
    "if (rnState === 'failed') throw new Error("].map((text) => importBody.indexOf(text));
assert(importOrder.every((index, i) => index > (i ? importOrder[i - 1] : -1)), `import order ${importOrder}`);
// A failed RN state change fails the boot closed: the catch only records it, and the throw is unconditional on the log.
assert.match(importBody, /catch \(error\) \{\s*rnState = 'failed';\s*rnFailure = [^\n]*\s*\}/);
assert.equal(importBody.match(/rnState = 'failed'/g).length, 1);
assert.equal(hostEntry.match(/saveData\(/g).length, 1, 'the import is the host\'s only direct save');
assert.equal(hostEntry.match(/rnStateCommit\(/g).length, 2, 'bridge type and one call');
const legacyLine = /extra: Record<string, string> = \{([\s\S]*?)\};/.exec(importBody)?.[1] ?? '';
assert(legacyLine.includes("releaseCheck: ios ? 'v1.3.3/native-ios-legacy-json-import' : 'v1.3.3/native-android-legacy-json-import'"));
// Field names (the counts come from core's plan) are listed in packages/core/src/release-diagnostics-fields.test.ts.
for (const [, name] of legacyLine.matchAll(/(\w+):/g)) assert.doesNotMatch(name, /key|pass|user/i);

const legacyState = (overrides = {}) => JSON.stringify({ jsonAhead: true, reconciled: true, backupVersion: '2', backupPresent: true, ...overrides });
const current = { tasks: [{ id: 'rn' }], projects: [], sections: [], areas: [], people: [], settings: {} };
const merged = { ...current, tasks: [{ id: 'rn' }, { id: 'json-only' }] };
const importPlan = { outcome: 'imported', path: 'json-ahead', merged, clearJsonAhead: true, setReconciled: false,
    counts: { backupTasks: 2, sqliteTasks: 1, mergedTasks: 2, tasksFromBackup: 1 } };
const legacyBoot = async ({ plan = importPlan, overrides = {}, backup = '{"tasks":[]}', setup = () => {} } = {}) => {
    const legacy = makeState('auto', [current]);
    legacy.plan = plan;
    setup(legacy);
    return { legacy, result: await poll(legacy, legacy.MindwtrHost.boot(legacyState(overrides), backup)) };
};
const commitOf = (clearJsonAhead, setReconciled) => `commit:${JSON.stringify({ clearJsonAhead, setReconciled })}`;

assert.equal(ready.events.includes('plan'), false, 'the dev database never plans an import');
{
    const { legacy, result } = await legacyBoot();
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(legacy.events.slice(0, 7), ['load', 'plan', 'save', 'load', commitOf(true, false), 'activate', 'load']);
    assert.deepEqual(JSON.parse(legacy.planInputs[0]), [
        { jsonAhead: true, reconciled: true, backupVersion: '2', backupJson: '{"tasks":[]}' }, 1, true]);
}
{
    const { legacy } = await legacyBoot({ overrides: { backupPresent: false, backupVersion: null } });
    assert.deepEqual(JSON.parse(legacy.planInputs[0])[0], { jsonAhead: true, reconciled: true, backupVersion: null, backupJson: null });
}
{
    const failed = makeState(5, [current]);
    failed.plan = importPlan;
    const result = await poll(failed, failed.MindwtrHost.boot(legacyState(), '{}'));
    assert.match(result.error, /Incomplete tasks load/);
    assert.deepEqual(failed.events, ['load'], 'a failed validated load plans, saves, and commits nothing');
}
{
    const { legacy, result } = await legacyBoot({ setup: (state) => { state.afterSave = current; } });
    assert.match(result.error, /Legacy import not confirmed: tasks/);
    assert.deepEqual(legacy.events, ['load', 'plan', 'save', 'load'], 'an unconfirmed import changes no RN state and never activates');
}
{
    // Every id is there, but one imported field did not persist.
    const lost = { ...merged, tasks: [{ id: 'rn' }, { id: 'json-only', title: 'lost' }] };
    const { legacy, result } = await legacyBoot({ setup: (state) => { state.afterSave = lost; } });
    assert.match(result.error, /Legacy import not confirmed/);
    assert.deepEqual(legacy.events, ['load', 'plan', 'save', 'load'], 'a content mismatch changes no RN state and never activates');
}
{
    // The retry after a failed RN state change: the import is already saved, so only the RN state change runs.
    const { legacy, result } = await legacyBoot({ setup: (state) => { state.fakeDataSequence = [merged]; state.fakeData = merged; } });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(legacy.events.slice(0, 4), ['load', 'plan', commitOf(true, false), 'activate']);
}
{
    const { legacy, result } = await legacyBoot({ setup: (state) => { state.saveError = 'disk full'; } });
    assert.match(result.error, /disk full/);
    assert.deepEqual(legacy.events, ['load', 'plan', 'save']);
}
{
    // A failed RN state change (the RKStorage checkpoint included) fails closed: the import stays, nothing activates.
    const { legacy, result } = await legacyBoot({ setup: (state) => { state.commitResult = '!MindwtrNativeError:Cannot create the RN state checkpoint'; } });
    assert.equal(result.ok, false);
    assert.match(result.error, /^Cannot update the previous app version's saved state: Cannot create the RN state checkpoint$/);
    assert.deepEqual(legacy.events, ['load', 'plan', 'save', 'load', commitOf(true, false)], 'no activation after a failed RN state change');
    assert.equal(legacy.activationCount, 0);
}
{
    const plan = { outcome: 'abandoned', path: 'json-ahead', reason: 'backup-corrupt', clearJsonAhead: true, setReconciled: true };
    const { legacy, result } = await legacyBoot({ plan, setup: (state) => { state.fakeData = current; } });
    assert.equal(result.ok, true);
    assert.deepEqual(legacy.events.slice(0, 3), ['load', 'plan', commitOf(true, true)], 'an abandoned backup saves nothing');
}
{
    const plan = { outcome: 'none', clearJsonAhead: false, setReconciled: false };
    const { legacy, result } = await legacyBoot({ plan, setup: (state) => { state.fakeData = current; } });
    assert.equal(result.ok, true);
    assert.deepEqual(legacy.events.slice(0, 3), ['load', 'plan', 'activate'], 'nothing to import: no save, no RN state change');
}
const brokenStorage = makeState(0);
brokenStorage.__mindwtrNative.sqlAll = () => '!MindwtrNativeError:disk I/O error';
const brokenBoot = await poll(brokenStorage, brokenStorage.MindwtrHost.boot());
assert.equal(brokenBoot.ok, false);
assert.match(brokenBoot.error, /disk I\/O error/);
assert.equal(brokenStorage.activationCount, 0);
// Review 2: MindwtrHost.cancel, as CoreHost calls it past a deadline, cancels the host's calls and fires the operation's
// signal, so the operation ends at once (here runNetDeadline in "drain" mode): its fetch rejects and its write is refused.
{
    const deadlineState = makeState(0);
    const fetches = [];
    deadlineState.__mindwtrNative.log = (line) => fetches.push(line);
    deadlineState.fetch = (url, init) => new Promise((_, reject) => {
        const refuse = () => reject(Object.assign(new Error(deadlineState.cancelled), { name: 'AbortError' }));
        fetches.push(`${init?.method ?? 'GET'} ${url}`);
        if (deadlineState.cancelled) refuse(); else deadlineState.cancelFetch = refuse;
    });
    deadlineState.__cancelHostCalls = (message) => { deadlineState.cancelled = message; deadlineState.cancelFetch(); };
    const id = deadlineState.MindwtrHost.netDeadline('18765', 'drain');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(deadlineState.MindwtrHost.poll(id), null, 'the operation waits on its unanswered request');
    assert.equal(deadlineState.MindwtrHost.cancel(id), null);
    const drained = await poll(deadlineState, id);
    assert.deepEqual(drained, { ok: true, value: ['signal', 'fetch:AbortError', 'write:AbortError'] });
    assert.deepEqual(fetches, ['GET http://127.0.0.1:18765/slow/deadline-drain', 'PUT http://127.0.0.1:18765/dav/after-drain.json',
        'Native Android net deadline drain events=["signal","fetch:AbortError","write:AbortError"]']);
    assert.equal(deadlineState.cancelled, 'The host operation timed out');
}
// Review C1 5: MindwtrHost.abort, as CoreHost.cancel(LongCall) calls it, aborts one AI request's signal: its provider call
// stops and the operation answers at once; no other host call is refused (unlike cancel, which drains everything).
{
    const ai = makeState(0);
    assert.equal((await poll(ai, ai.MindwtrHost.boot())).ok, true);
    let refused = false;
    ai.__cancelHostCalls = () => { refused = true; };
    const id = ai.MindwtrHost.aiRequest('requestTaskEditorClarify', '{"id":"t"}');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(ai.MindwtrHost.poll(id), null, 'the request waits on its provider');
    assert.deepEqual([...ai.aiInputs], ['{"id":"t"}']);
    assert.equal(ai.MindwtrHost.abort(id), null);
    assert.deepEqual(await poll(ai, id), { ok: false, error: 'The AI request was cancelled' });
    assert.equal(refused, false, 'abort refuses no other host call');
}
// Review 6: check-net-device.mjs cleans up once, whether it ends, is interrupted (Ctrl-C) or is terminated, and a signal
// exits with 128 + its number. A failing step (the phone gone) does not stop the steps after it.
{
    const { spawnSync } = await import('node:child_process');
    const script = (ending) => `import { cleanupOnExit } from ${JSON.stringify(resolve(app, 'scripts/check-net-device.mjs'))};
        const cleanup = cleanupOnExit([() => console.log('props'), () => { throw new Error('phone gone'); }, () => console.log('reverse')]);
        setTimeout(() => {}, 10000);
        ${ending}`;
    for (const [ending, status] of [["process.kill(process.pid, 'SIGINT');", 130], ["process.kill(process.pid, 'SIGTERM');", 143], ['cleanup(); cleanup(); process.exit(0);', 0]]) {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script(ending)], { encoding: 'utf8', timeout: 20_000 });
        assert.deepEqual([child.status, child.stdout], [status, 'props\nreverse\n'], ending);
    }
}
// Core's logger on the file bridge, with core's real diagnostics-log.ts: RN's gate, force, line and sanitizer; one append per line.
{
    const log = makeState(0);
    assert.equal((await poll(log, log.MindwtrHost.boot())).ok, true);
    const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
    const lines = () => (log.logText ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    log.logOps.length = 0;
    log.coreLogger({ level: 'info', message: 'not written' });
    await tick();
    assert.deepEqual(log.logOps, [], 'debug logging off: no file work at all');
    log.coreLogger({ level: 'warn', message: 'forced token=secret-value', scope: 'diagnostics', force: true });
    await tick();
    assert.deepEqual(lines().map(({ ts: _ts, ...line }) => line), [{ level: 'warn', scope: 'diagnostics', message: 'forced token=[redacted]' }]);
    // Review S3 2 and 3 through the real bundle: core's sanitizer on the polyfill's URL.
    log.coreLogger({ level: 'warn', message: 'GET https://alice:p@ss@nas.local/dav failed; GET https://nas.local/dav?token=first&token=second failed', scope: 'sync', force: true });
    await tick();
    const sanitized = lines().at(-1).message;
    assert.match(sanitized, /nas\.local\/dav failed/);
    for (const secret of ['alice', 'p@ss', 'ss@', 'first', 'second']) assert(!sanitized.includes(secret), `the sanitized line keeps "${secret}": ${sanitized}`);
    log.settings = { diagnostics: { loggingEnabled: true } };
    log.coreLogger({ level: 'info', message: 'Native Android task command', category: 'storage', context: { operation: 'complete', password: 'p' } });
    await tick();
    const last = lines().at(-1);
    assert.deepEqual(Object.keys(last), ['ts', 'level', 'scope', 'message', 'context']);
    assert.deepEqual({ ...last, ts: '' }, { ts: '', level: 'info', scope: 'core', message: 'Native Android task command', context: { operation: 'complete', password: '[redacted]', category: 'storage' } });
    assert.match(last.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(log.logOps.filter((op) => op === 'append').length, 3, 'one append per line');
    assert.equal(log.logOps.filter((op) => op === 'write').length, 0, 'no rewrite under the size cap');
    assert.deepEqual(await poll(log, log.MindwtrHost.logShare()), { ok: true, value: { path: 'files/logs/mindwtr.log' } });
    assert.deepEqual(await poll(log, log.MindwtrHost.logClear()), { ok: true, value: {} });
    assert.equal(log.logText, null);
    // A failing bridge never reaches the caller: the line is dropped, and Share gets no path.
    log.logFailure = 'disk full';
    assert.doesNotThrow(() => log.coreLogger({ level: 'error', message: 'lost', force: true }));
    await tick();
    assert.deepEqual(await poll(log, log.MindwtrHost.logShare()), { ok: true, value: { path: null } });
}
// iOS uses the real shared logger/queue and strict native probe, including while a domain retry is owed.
{
    const log = makeState(0, [], 'ios');
    assert.equal((await poll(log, log.MindwtrHost.boot())).ok, true);
    assert(log.receiptScope.includes('data'), 'Apple scoped bootstrap durably acknowledges Data toggles');
    log.persistenceStatus = { generation: 1, queued: true, inFlight: false, immediate: false, retrying: false, failed: true };
    log.persistenceFailure = { kind: 'save_failed', message: 'owed domain write' };
    const domainBefore = JSON.stringify({ events: log.events, fakeData: log.fakeData, saves: log.saveCount, menuInputs: log.menuInputs });
    log.logOps.length = 0;
    log.coreLogger({ level: 'info', message: 'earlier diagnostic', force: true });
    assert.deepEqual(await poll(log, log.MindwtrHost.logShare()), { ok: true, value: { path: 'files/logs/mindwtr.log' } });
    const lines = log.logText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines.map(({ ts: _ts, ...line }) => line), [
        { level: 'info', scope: 'core', message: 'earlier diagnostic' },
        { level: 'info', scope: 'native-ios', message: 'Native iOS diagnostics share requested', context: { releaseCheck: 'v1.3.4/ios-diagnostics', operation: 'share' } },
    ], 'the forced iOS aggregate marker reaches actual file bytes before the live path is returned');
    assert.equal(log.logOps.at(-1), 'ensure', 'the final export barrier follows every earlier append');
    assert.equal(log.logOps.filter((op) => op === 'append').length, 2);
    log.logOps.length = 0;
    assert.deepEqual(await poll(log, log.MindwtrHost.logClearChecked()), { ok: true, value: { outcome: 'cleared' } });
    assert.equal(log.logText, null);
    assert.deepEqual(log.logOps, ['delete', 'path', 'isAbsent'], 'checked Clear writes no success line');
    assert.deepEqual(await poll(log, log.MindwtrHost.logClearChecked()), { ok: true, value: { outcome: 'alreadyAbsent' } });
    assert.equal(log.logText, null);
    assert.equal(JSON.stringify({ events: log.events, fakeData: log.fakeData, saves: log.saveCount, menuInputs: log.menuInputs }), domainBefore, 'file-only calls do not retry or mutate domain work');
    log.logText = 'retained';
    log.logDeleteRefused = true;
    assert.deepEqual(await poll(log, log.MindwtrHost.logClearChecked()), { ok: true, value: { outcome: 'unconfirmed' } });
    assert.equal(log.logText, 'retained');
    log.logDeleteRefused = false;
    log.logAbsentError = true;
    assert.deepEqual(await poll(log, log.MindwtrHost.logClearChecked()), { ok: true, value: { outcome: 'unconfirmed' } });
    log.logAbsentError = false;
    log.logUnavailable = true;
    assert.deepEqual(await poll(log, log.MindwtrHost.logClearChecked()), { ok: true, value: { outcome: 'unavailable' } });
}
console.log('Storage exception rethrown in JS;', 'lifecycle ownership and debug-only fault hooks checked');
console.log('RN legacy guard runs before the RN database opens and reads RKStorage and the database only as byte copies');
console.log('Editor: core\'s model and suggestions in, saveTaskDraft out through perform with an exact retry, changed fields only, no Kotlin date parsing');
console.log('Focus: reads only through CoreHost, core order and flags only, stale windows restart, blocked after a failed save');
console.log('Labels: every UI word from core getStrings, one key map filled after setLanguage, debug-only language override');
console.log('Theme: one Kotlin theme object equal to RN\'s palettes, no color elsewhere, core resolves the mode and owns its hues');
console.log('Accessibility: the failure banner sits above the list (zIndex, live region, first in traversal); sections expose core\'s text');
console.log('Projects: reads only through CoreHost, core order and groups only, stale windows restart, blocked after a failed save');
console.log('RN legacy import: after the validated load, confirmed by a re-read before RN state changes; RKStorage checkpointed first');
console.log('Search and Process Inbox: core reads in the background with freshness, answers and saves through perform with exact, persisted requests');
console.log('RN look: rows read core meta (no Kotlin date formatting or coloring); stars, status, new project, and area filter run through perform with exact retries');
console.log('Menu tab: core\'s menu views through CoreHost, writes through perform with exact requests, Someday creates on disk first, no Kotlin policy');
console.log('Contexts, Trash, Review and the reviews: core\'s views, core\'s actions through perform, destructive actions behind core\'s question, checkpoints under core\'s keys');
console.log('Calendar and Board: core\'s views under one revision, core\'s actions through perform, composer and Duplicate on disk first, a drop is one core action, no Kotlin date math or policy');
console.log('Toolbars and bulk: the Inbox on core\'s view, core\'s bulk bar and Focus controls through perform with exact requests, a saved Focus filter on disk first, stateless Select all, no deprecated Archive fields, no Kotlin policy');
console.log('Review organize and picker search: row and batch Mark reviewed and Organize\'s Apply carry core\'s task revisions, a stale refusal rereads core\'s view, the Organize sheet is the lists\' dialog on Review\'s bar, the token and Board pickers search through core, and a search hit is highlighted on the list it opened on');
console.log('Settings and the editor\'s View tab: core\'s settings and task views through CoreHost, writes through perform with exact requests, device writes under RN\'s keys, checklist edits as core\'s edits in the one save');
console.log('Mind Sweep and saved searches: core\'s views through CoreHost, captures and Bulk organize creates on disk first, stale windows read again whole, Focus picker search, no Kotlin policy');
console.log('App lock: core\'s General row read at boot and after a failed save, locked on each leave but a rotation, no recents picture while on, AndroidX BiometricPrompt with Expo\'s credential fallback, General\'s switch on only after a yes, a scrolling lock screen in core\'s words, and a phone check that swaps the database atomically and restores loudly');
console.log('Diagnostics log: core\'s rules on Kotlin\'s file bridge (RN\'s path, gate, force, line, sanitizer), Share through a private FileProvider and the share sheet, Clear, Data\'s card from core');
// One run per phone: every device check waits for its phone's lock before anything else (device-lock.mjs).
for (const file of ['device.mjs', 'check-net-device.mjs']) {
    assert.match(readFileSync(resolve(app, `scripts/${file}`), 'utf8'), /^import '\.\/device-lock\.mjs';$/m, `${file} waits for the phone's lock first`);
}
console.log('Entry points: RN\'s alias, links on the build\'s scheme, text shares and Assistant notes read as strings into core\'s resolveNativeEntryPoint, RN\'s shortcuts from RN\'s builder, Import .txt through core');
// Pass B3 (R1 native): core's reminder planner and timers in the engine (host-reminders.ts); Kotlin applies each plan in core's
// order (ReminderPlanTest), posts what a fired alarm carries, sends Done and Snooze to CoreWork as journaled core commands, plans
// again after a reboot, a clock change or an update, and cancels RN's alarms once.
{
    const remindersKt = source('Reminders.kt');
    const notificationsKt = source('CoreNotifications.kt');
    const manifest = readFileSync(resolve(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    // Alarms and the buttons come only from this app's PendingIntents; the reschedule receiver takes only actions the system sends.
    assert.match(manifest, /<receiver\s+android:name="\.ReminderAlarmReceiver"\s+android:exported="false" \/>/);
    assert.match(manifest, /<receiver\s+android:name="\.ReminderActionReceiver"\s+android:exported="false" \/>/);
    const reschedule = manifest.match(/<receiver\s+android:name="\.ReminderRescheduleReceiver"[\s\S]*?<\/receiver>/)[0];
    assert.deepEqual([...reschedule.matchAll(/<action android:name="([^"]+)"/g)].map((m) => m[1]), ['android.intent.action.BOOT_COMPLETED',
        'android.intent.action.TIME_SET', 'android.intent.action.TIMEZONE_CHANGED', 'android.intent.action.MY_PACKAGE_REPLACED',
        'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED']);
    assert.doesNotMatch(manifest, /android:process=/, 'one process: two hosts on one database reject each other\'s writes');
    assert.match(remindersKt, /action == DEBUG_RESCHEDULE && BuildConfig\.DEBUG\)\) return/, 'the debug reschedule only in a debug build');
    // Kotlin decides no alarm: no timer, no reason and no id of its own (core's id is the request code and the notification's id).
    assert.doesNotMatch(code(remindersKt + notificationsKt), /postDelayed|Handler\(|Timer\(|"expired"|hashCode\(\)|Random\(/);
    assert.match(remindersKt, /PendingIntent\.getBroadcast\(context, alarm\.getInt\("id"\), fireIntent\(context\)/);
    assert.match(notificationsKt, /val id = alarm\.getInt\("id"\)/);
    for (const text of [remindersKt, notificationsKt]) {
        for (const call of code(text).matchAll(/PendingIntent\.get(?:Broadcast|Activity)\([\s\S]{0,240}/g)) assert.match(call[0], /^[^]*?FLAG_IMMUTABLE/, 'every PendingIntent is immutable');
    }
    // Exact when Android allows it, else allowed while idle, as RN's patched library sets an alarm.
    assert.match(remindersKt, /if \(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S \|\| manager\.canScheduleExactAlarms\(\)\) \{\s+manager\.setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, at, intent\)\s+\} else \{\s+manager\.setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, at, intent\)/);
    // RN's alarms through RN's receiver's name and its request codes (the row's alarmId), before the maps go, then the table.
    assert.match(remindersKt, /RN_RECEIVER = "com\.emekalites\.react\.alarm\.notification\.AlarmReceiver"/);
    // RN's release builds shrink AlarmModel's field names: every whole number in a row is a candidate request code.
    assert.match(remindersKt, /data\.optInt\("alarmId", Int\.MIN_VALUE\)/);
    assert.match(remindersKt, /PendingIntent\.getBroadcast\(context, id, intent, PendingIntent\.FLAG_NO_CREATE or PendingIntent\.FLAG_IMMUTABLE\)/, 'a candidate that names no RN alarm cancels nothing');
    // Done and Snooze: CoreWork jobs, unique per request, journaled host methods (WriteJournal.SHAPES), the tap's time with Snooze.
    assert.match(source('CoreWork.kt'), /requestId != null -> work\.enqueueUniqueWork\("mindwtr-core-\$job-\$requestId", ExistingWorkPolicy\.KEEP, request\)/);
    assert.match(remindersKt, /"requestedAt" to System\.currentTimeMillis\(\)\.toString\(\)/);
    // A receiver's job is stored before its notification goes and before its process may end (goAsync until WorkManager answered).
    assert.doesNotMatch(code(remindersKt), /CoreWork\.enqueue\(/, 'every reminder receiver queues durably');
    assert.equal([...code(remindersKt).matchAll(/CoreWork\.enqueueDurably\(this, context,/g)].length, 4, 'Done, Snooze, the reschedule and a repeat that fired');
    // A daily or weekly alarm that fired is made again by core's plan, never at a time Kotlin works out; a delivery checks, under the
    // lock each plan's apply holds, that no plan cancelled or moved its alarm meanwhile.
    assert.doesNotMatch(code(remindersKt), /Calendar|TimeZone|nextRepeat/);
    assert.match(remindersKt, /CoreJob\.REMINDERS, mapOf\("mode" to "fired", "key" to alarm\.getString\("key"\)\)/);
    assert.match(remindersKt, /synchronized\(ReminderAlarms\.LOCK\) \{\s+ReminderLedger\.of\(context\)\.deliver\(/);
    // The ledger is on disk and written before any alarm changes, so a cancel holds across a process death.
    assert.match(remindersKt, /port\.record\(cancelled = [\s\S]{0,260}\)\s+for \(index in 0 until cancel\.length\(\)\)/);
    assert.match(remindersKt, /synchronized\(LOCK\) \{ applyLocked\(parsed\) \}/);
    assert.match(hostEntry, /reminderDone\(requestId: string, taskId: string\): string \{\s+return submit\(async \(\) => taskResult\('reminderDone', await contract\.completeReminderTask\(\{ requestId, taskId \}\)\)\);/);
    // Snooze's alarm is made in the engine against the native state (core's planReminderSnooze), before the journaled reply.
    assert.match(hostEntry, /reminderSnooze\(json: string\): string \{\s+return submit\(async \(\) => \{\s+const result = await contract\.snoozeReminder\(JSON\.parse\(json\)\);\s+if \(result\.ok\) await requireReminders\(\)\.snooze\(result\.value\);\s+return taskResult\('reminderSnooze', result\);/);
    // RN's look (react-native-alarm-notification's sendNotification and channel, patched): private on the lock screen (#823), a
    // reminder at default priority with the notification sound; the channel at default importance, lights, no vibration, no DnD
    // bypass. Only reminder notifications are cleared without permission (the quick-capture one is not, #819). Snooze and Done
    // take the notification away once their job is stored (RN's snooze dismissal).
    assert.match(notificationsKt, /\.setPriority\(NotificationCompat\.PRIORITY_DEFAULT\)/);
    assert.match(notificationsKt, /\.setVisibility\(NotificationCompat\.VISIBILITY_PRIVATE\)/);
    assert.match(notificationsKt, /\.setCategory\(NotificationCompat\.CATEGORY_REMINDER\)/);
    assert.match(notificationsKt, /if \(details\.optBoolean\("play_sound", true\)\) Settings\.System\.DEFAULT_NOTIFICATION_URI else null/);
    assert.match(notificationsKt, /NotificationChannel\(id, name, NotificationManager\.IMPORTANCE_DEFAULT\)\.apply \{\s+description = name\s+enableLights\(true\)\s+color\?\.let \{ lightColor = it \}\s+enableVibration\(false\)\s+setSound\(Settings\.System\.DEFAULT_NOTIFICATION_URI, AudioAttributes\.Builder\(\)\s+\.setUsage\(AudioAttributes\.USAGE_NOTIFICATION\)/);
    assert.doesNotMatch(code(notificationsKt), /setBypassDnd|setOngoing|FLAG_INSISTENT/);
    assert.match(remindersKt, /override fun clearDelivered\(\) \{\s+for \(shown in notifications\.activeNotifications\) \{\s+if \(NotificationCompat\.getChannelId\(shown\.notification\) == CoreNotifications\.REMINDER_CHANNEL\)/);
    assert.doesNotMatch(code(remindersKt + notificationsKt), /cancelAll\(\)/, 'nothing clears the whole tray');
    assert.equal([...code(remindersKt).matchAll(/\), done = dismiss\)/g)].length, 2, 'Done and Snooze dismiss once stored');
    // RN's start-time permission question waits for the reminder alarms' start (they start with sync, after first content).
    assert.match(source('InboxViewModel.kt'), /suspend fun askNotifications\(\): Boolean \{\s+ProcessCoreHost\.remindersStarted\.await\(\)/);
    assert.equal([...source('ProcessCoreHost.kt').matchAll(/remindersStarted\.complete\(Unit\)/g)].length, 2, 'a start, or a resume\'s start after a failed one');
    // The debug-only stops and the short snooze read a debug property (empty in a release build).
    assert.match(remindersKt, /if \(debugProperty\("reminder_stop"\) == point\)/);
    assert.match(remindersKt, /debugProperty\("snooze_minutes"\)\.toDoubleOrNull\(\)/);
}
// host-reminders.ts with a stand-in core and bridge: RN's alarms cancelled once before the first plan (a failed cleanup plans
// nothing), cycles one at a time, the plan applied with the channel's name, the store timer after the last change, the top-up, the
// exact rebuild's pending mark, the tap's re-plan, and nothing at all in sandbox mode.
{
    const stand = `
export const REMINDER_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
export const REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS = 5;
export const REMINDER_STORE_RESCHEDULE_DELAY_MS = 30;
export const hasActiveMobileNotificationFeature = (settings) => settings.on === true;
export const isSandboxMode = () => globalThis.reminderSandbox === true;
export const logInfo = () => {}; export const logWarn = () => {};
export const nameNotifyListener = (_name, listener) => listener;
export const shouldRescheduleReminderAlarms = (state, previous) => state.tasks !== previous.tasks;
const listeners = [];
let state = { tasks: [], settings: { on: true } };
export const useTaskStore = { getState: () => state, subscribe: (listener) => { listeners.push(listener); return () => {}; },
  setState: (next) => { const previous = state; state = { ...state, ...next }; listeners.forEach((listener) => listener(state, previous)); } };
globalThis.standStore = useTaskStore;
`;
    const out = await build({ entryPoints: [resolve(app, 'bundle/host-reminders.ts')], bundle: true, write: false, format: 'esm',
        plugins: [{ name: 'stand-core', setup(plugin) {
            plugin.onResolve({ filter: /^@mindwtr\/core$/ }, () => ({ path: 'core', namespace: 'stand' }));
            plugin.onLoad({ filter: /.*/, namespace: 'stand' }, () => ({ contents: stand, loader: 'js' }));
        } }] });
    const mod = await import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`);
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const calls = [];
    let stored = '{"task:a":{"id":7,"signature":"s"}}';
    let cleanupFailure = true;
    let topUp = null;
    let storedState = null;
    let planState = '{}';
    let lastPlan = null;
    const applied = [];
    const reminders = mod.createNativeReminders({
        plan: async (input) => {
            calls.push(`plan ${input.storedAlarms} ${input.permissionGranted}${input.remake ? ` remake ${input.remake}` : ''}`);
            lastPlan = input;
            await sleep(5);
            return { ok: true, value: { mode: 'active', cancel: [], schedule: [], alarms: '{}', state: planState, topUpDelayMs: topUp } };
        },
        readStored: async () => ({ alarms: stored, state: storedState }),
        planSnooze: (input) => { calls.push(`snooze ${input.storedState} ${input.alarm.key} ${input.permissionGranted}`); return { ok: true, value: { schedule: [input.alarm], stateAhead: '{"ahead":1}', state: '{"after":1}' } }; },
        permissionGranted: () => false,
        apply: (json) => { calls.push(`apply ${JSON.parse(json).channelName}`); applied.push(JSON.parse(json)); },
        cleanupRn: () => { calls.push('cleanup'); if (cleanupFailure) throw new Error('rnandb locked'); return 2; },
    });
    await assert.rejects(reminders.start(), /rnandb locked/);
    assert.deepEqual(calls, ['cleanup'], 'a failed cleanup plans nothing');
    cleanupFailure = false;
    calls.length = 0;
    const started = await reminders.start();
    assert.equal(started.rnCancelled, 2);
    assert.equal(started.ask, true, 'a feature on and no permission: RN asks at start');
    // The process's first plan remakes every held alarm: Android dropped them if exact-alarm access was revoked (it stops the app)
    // or the app was force-stopped, and the stored map still says each is held.
    assert.deepEqual(calls, ['cleanup', `plan ${stored} false remake all`, 'apply Mindwtr reminders']);
    // Cycles run one at a time; the cleanup ran once.
    calls.length = 0;
    await Promise.all([reminders.cycle(false), reminders.cycle(false)]);
    assert.deepEqual(calls, [`plan ${stored} false`, 'apply Mindwtr reminders', `plan ${stored} false`, 'apply Mindwtr reminders']);
    // The rebuild (a reboot, a clock change, exact alarms allowed) marks every held alarm pending.
    calls.length = 0;
    await reminders.cycle(true);
    assert.deepEqual(calls, [`plan ${stored} false remake all`, 'apply Mindwtr reminders']);
    // Store changes: one plan, REMINDER_STORE_RESCHEDULE_DELAY_MS after the last accepted change; other changes plan nothing.
    calls.length = 0;
    globalThis.standStore.setState({ tasks: [] });
    await sleep(10);
    globalThis.standStore.setState({ tasks: [] });
    globalThis.standStore.setState({ settings: { on: true } });
    await sleep(15);
    assert.deepEqual(calls, [], 'no plan before the delay after the last change');
    await sleep(40);
    assert.deepEqual(calls, [`plan ${stored} false`, 'apply Mindwtr reminders'], 'one plan after the last accepted change');
    globalThis.standStore.setState({ settings: { on: true } });
    await sleep(50);
    assert.equal(calls.length, 2, 'a change the rule does not accept plans nothing');
    // The tap's re-plan and the top-up, each one plan.
    calls.length = 0;
    reminders.event();
    await sleep(40);
    assert.deepEqual(calls, [`plan ${stored} false`, 'apply Mindwtr reminders'], 'a tap plans again shortly after');
    calls.length = 0;
    topUp = 10;
    await reminders.cycle(false);
    topUp = null;
    await sleep(60);
    assert.deepEqual(calls, [`plan ${stored} false`, 'apply Mindwtr reminders', `plan ${stored} false`, 'apply Mindwtr reminders'], 'the top-up plans once more');
    // A daily or weekly alarm that fired: core makes that one again (its next time, or cancels it when turned off).
    calls.length = 0;
    await reminders.fired('digest:morning');
    assert.deepEqual(calls, [`plan ${stored} false remake digest:morning`, 'apply Mindwtr reminders']);
    // A Snooze: core's answer against the stored state, applied in the queue as a plan that only stores that state and makes it.
    applied.length = 0;
    calls.length = 0;
    storedState = '{"x":1}';
    const snoozeAlarm = { key: 'snooze:u', id: 1073741900, fireAtMs: 5, repeat: 'once', details: { title: 'Pay rent' }, replacing: null };
    await reminders.snooze(snoozeAlarm);
    assert.deepEqual(calls, ['snooze {"x":1} snooze:u false', 'apply Mindwtr reminders'], 'the Snooze is judged with the permission');
    assert.deepEqual(applied, [{ mode: 'active', cancel: [], schedule: [snoozeAlarm], writeAhead: null, stateAhead: '{"ahead":1}', alarms: stored,
        unchanged: true, state: '{"after":1}', topUpDelayMs: null, clearDelivered: false, channelName: 'Mindwtr reminders' }]);
    storedState = null;
    // The native state goes in and comes back; stored again only when it changed (none stored reads as an empty state).
    applied.length = 0;
    await reminders.cycle(false);
    storedState = '{"task:b":{"kind":"delivered","id":8,"firedAtMs":1}}';
    await reminders.cycle(false);
    assert.equal(lastPlan.storedState, storedState);
    planState = storedState;
    await reminders.cycle(false);
    assert.deepEqual(applied.map((plan) => plan.state), [null, '{}', null], 'the state is stored only when it changed');
    storedState = null;
    planState = '{}';
    // Sandbox mode: no plan at all.
    calls.length = 0;
    globalThis.reminderSandbox = true;
    // (A fresh controller further below: a store change during the first cycle plans again.)
    assert.deepEqual(await reminders.start(), { mode: 'sandbox', ask: false });
    await reminders.cycle(false);
    reminders.event();
    await sleep(20);
    assert.deepEqual(calls, []);
    globalThis.reminderSandbox = false;
    // The store subscription is armed before the first cycle: a change while it plans (a sync, a Done) plans again after it.
    const early = [];
    const fresh = mod.createNativeReminders({
        plan: async () => { early.push('plan'); await sleep(20); return { ok: true, value: { mode: 'active', cancel: [], schedule: [], alarms: '{}', state: '{}', topUpDelayMs: null } }; },
        planSnooze: () => { throw new Error('no snooze here'); },
        readStored: async () => ({ alarms: null, state: null }),
        permissionGranted: () => true,
        apply: () => early.push('apply'),
        cleanupRn: () => 0,
    });
    // What a receiver dropped or could not queue since the last plan goes in that plan's summary line.
    const counted = mod.createNativeReminders({
        plan: async () => ({ ok: true, value: { mode: 'active', cancel: [], schedule: [], alarms: '{}', state: '{}', topUpDelayMs: null } }),
        planSnooze: () => { throw new Error('no snooze here'); },
        readStored: async () => ({ alarms: null, state: null }),
        permissionGranted: () => true,
        apply: () => {},
        cleanupRn: () => 0,
        receiverCounts: () => ({ dropped: 2, notQueued: 1 }),
    });
    assert.deepEqual(await counted.cycle(false), { mode: 'active', rebuild: true, scheduled: 0, withdrawn: 0, expired: 0, held: 0, dropped: 2, notQueued: 1 });
    // The ledger (Kotlin): what showed and what is still in the tray go into every plan and every Snooze.
    const ledgerInputs = [];
    const withLedger = mod.createNativeReminders({
        plan: async (input) => { ledgerInputs.push(['plan', input.fired, input.shown]); return { ok: true, value: { mode: 'active', cancel: [], schedule: [], alarms: '{}', state: '{}', topUpDelayMs: null } }; },
        planSnooze: (input) => { ledgerInputs.push(['snooze', input.fired]); return { ok: true, value: { schedule: [], stateAhead: null, state: null } }; },
        readStored: async () => ({ alarms: null, state: null }),
        permissionGranted: () => true,
        apply: () => {},
        cleanupRn: () => 0,
        ledger: () => ({ fired: [7], shown: [7, 9] }),
    });
    await withLedger.cycle(false);
    await withLedger.snooze({ key: 'snooze:u', id: 1073741900, fireAtMs: 5, repeat: 'once', details: {}, replacing: null });
    assert.deepEqual(ledgerInputs, [['plan', [7], [7, 9]], ['snooze', [7]]]);
    const starting = fresh.start();
    await sleep(5);
    globalThis.standStore.setState({ tasks: [] });
    await starting;
    await sleep(80);
    assert.deepEqual(early, ['plan', 'apply', 'plan', 'apply'], 'a change during the first cycle plans again');
}
console.log('Reminders: core plans and times every alarm in the engine, Kotlin applies each plan in core\'s order, the buttons and the reschedule go through CoreWork as core\'s commands, RN\'s alarms cancelled once before the first plan');
console.log('Runner: CoreWork on the one host after the app\'s boot order, the queue drain after the journal replay, the queue\'s file and RKStorage ports, RN\'s capture intent and context receivers under RN\'s names, RN\'s capture intent Kotlin compiled in, the token only in Kotlin');
// Review finding 3 (A2): a failure on a path that can carry a URI (attachments, links, sync, the shared log, core actions) is logged
// by its class and core's code (failureForLog, attachmentLaunchLog), never with its message or stack, which can hold a credential URI.
{
    const pilot = resolve(app, 'android/app/src/main/java/tech/dongdongbh/mindwtr/pilot');
    // A Log call whose last argument, after its message string, is the throwable itself.
    const rawThrowable = /Log\.[weid]\([^\n]*"\s*,\s*(it|failure|error|e|t)\)/;
    for (const file of ['Attachments.kt', 'SyncSettings.kt', 'SettingsModel.kt', 'AISettings.kt']) {
        assert.doesNotMatch(readFileSync(resolve(pilot, file), 'utf8'), rawThrowable, `${file} logs no raw throwable`);
    }
    const lines = (file) => readFileSync(resolve(pilot, file), 'utf8').split('\n');
    for (const [file, events] of [['InboxViewModel.kt', ['Core action failed', 'Editor draft not restored']],
        ['ProcessCoreHost.kt', ['install recovery failed', 'sync start failed', 'sync app state failed']]]) {
        for (const line of lines(file).filter((text) => events.some((event) => text.includes(event)))) {
            assert.doesNotMatch(line, rawThrowable, `${file}: ${line.trim()}`);
        }
    }
}
// Review finding 2 (A2): a project file command whose copy hangs (a stalled document provider) ends at its deadline. The host's
// cancel rejects every open file call and asks the host to abort it (HostIo.fileAbort), so the operation drains and the host never
// stops; the call's late answer settles nothing.
{
    const aborted = [];
    const answers = [];
    let ids = 0;
    const bridge = {
        log() {}, nowMs: () => 0,
        fileCall: () => String(++ids),
        installerCall: () => String(++ids),
        fileAbort(id) { aborted.push(id); return null; },
        ioNext: () => answers.shift() ?? '',
        ioBody: () => '',
    };
    const files = vm.createContext({ console: { info() {} }, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8'), files);
    const held = vm.runInContext("__mindwtrFileCall({ op: 'copy', uri: 'content://provider/document/1', to: 'file:///data/user/0/app/files/attachments/a.pdf' })", files);
    const outcome = held.then(() => 'resolved', (error) => `${error.name}: ${error.message}`);
    files.__cancelHostCalls('The host operation timed out');
    assert.equal(await outcome, 'AbortError: The host operation timed out', 'a held file call rejects when its operation is cancelled');
    assert.deepEqual(aborted, ['1'], 'the host is asked to abort the held call');
    answers.push(JSON.stringify({ id: '1', value: null }));
    files.__pumpTimers();
    const refused = await vm.runInContext("__mindwtrFileCall({ op: 'getInfo', uri: 'file:///x' })", files).then(() => 'resolved', (error) => error.name);
    assert.equal(refused, 'AbortError', 'no new file call starts while the operation drains');
    files.__resumeHostCalls();
}
// Passive calendar reads share the value pump, but cancellation targets only the calendar provider.
{
    const polyfills = readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8');
    const answers = [], aborted = [], submitted = [];
    let sequence = 0, failure = null;
    const bridge = {
        log() { throw new Error('Calendar transport must not log provider exceptions'); }, nowMs: () => 0,
        calendarCall(text) {
            if (failure === 'throw') throw new Error('Calendar read unavailable');
            if (failure === 'native') return '!MindwtrNativeError:Calendar read unavailable';
            submitted.push(JSON.parse(text)); return `cal:1:${++sequence}`;
        },
        calendarAbort(id) { aborted.push(['calendar', id]); throw new Error('Calendar abort unavailable'); },
        fileCall: () => 'file:1:1', installerCall: () => 'installer:1:1',
        fileAbort(id) { aborted.push(['file', id]); },
        ioNext: () => answers.shift() ?? '',
        ioBody() { throw new Error('Calendar replies are bodyless'); },
    };
    const state = vm.createContext({ __mindwtrNative: bridge });
    vm.runInContext(polyfills, state);
    assert.deepEqual(submitted, [], 'installing the calendar capability never reads or prompts');
    const held = state.__mindwtrCalendarCall({ op: 'events', calendarIds: ['é'], startMs: 0, endMs: 1 });
    const outcome = held.then(() => 'resolved', (error) => `${error.name}: ${error.message}`);
    const file = assert.rejects(state.__mindwtrFileCall({ op: 'getInfo' }), { name: 'AbortError' });
    const installer = assert.rejects(state.__mindwtrInstallerCall({ op: 'install' }), { name: 'AbortError' });
    state.__cancelHostCalls('Calendar operation cancelled');
    assert.equal(await outcome, 'AbortError: Calendar operation cancelled', 'cancellation rejects without waiting for native completion');
    await Promise.all([file, installer]);
    assert.deepEqual(aborted, [['calendar', 'cal:1:1'], ['file', 'file:1:1'], ['file', 'installer:1:1']],
        'calendar uses calendarAbort; existing file and installer keep fileAbort');
    await assert.rejects(state.__mindwtrCalendarCall({ op: 'permissions' }), { name: 'AbortError' });
    assert.equal(submitted.length, 1, 'cancelled operation cannot start another calendar read');
    answers.push(...['cal:1:1', 'file:1:1', 'installer:1:1'].map((id) => JSON.stringify({ id, value: [] })));
    assert.equal(state.__pumpTimers(), 0, 'cancelled late answers are drained without settling promises');
    state.__resumeHostCalls();
    const retry = state.__mindwtrCalendarCall({ op: 'permissions' });
    answers.push(JSON.stringify({ id: 'cal:1:2', value: { status: 'granted' } }));
    assert.equal(state.__pumpTimers(), 1, 'late cancellation leaves the next read live');
    assert.equal((await retry).status, 'granted');
    assert.deepEqual(submitted, [{ op: 'events', calendarIds: ['é'], startMs: 0, endMs: 1 }, { op: 'permissions' }]);
    const refused = assert.rejects(state.__mindwtrCalendarCall({ op: 'calendars' }), /^Error: Calendar read unavailable$/);
    answers.push(JSON.stringify({ id: 'cal:1:3', error: 'Calendar read unavailable' }));
    assert.equal(state.__pumpTimers(), 1); await refused;
    for (const mode of ['throw', 'native']) {
        failure = mode;
        await assert.rejects(state.__mindwtrCalendarCall({ op: 'permissions' }), /^\w*Error: Calendar read unavailable$/);
        assert.equal(state.__pumpTimers(), 0, 'submission exception does not leave an open pump slot');
    }
    for (const native of [undefined, { log() {} }, { log() {}, fileCall() {} }]) {
        const absent = vm.createContext({ __mindwtrNative: native });
        vm.runInContext(polyfills, absent);
        assert.equal(absent.__mindwtrCalendarCall, undefined, 'calendar capability absent stays unavailable');
    }
}
// Review finding 1 (A2): a managed attachment's delete asks core's keep() in the same engine turn as the delete itself, after every
// file call queued before it. Here a delete waits behind a held file call while the attachment is restored: the bytes stay.
{
    const bundled = await build({
        stdin: { contents: "export { createNativeAttachments } from './host-attachments';", resolveDir: resolve(app, 'bundle'), loader: 'ts' },
        bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    });
    const scratch = mkdtempSync(resolve(tmpdir(), 'host-attachments-'));
    try {
        writeFileSync(resolve(scratch, 'host-attachments.mjs'), bundled.outputFiles[0].text);
        const { createNativeAttachments } = await import(resolve(scratch, 'host-attachments.mjs'));
        const deleteRace = async (restoreWhileWaiting) => {
            const document = 'file:///data/user/0/app/files/';
            let release;
            const held = new Promise((done) => { release = done; });
            let waiting = false;
            const deleted = [];
            const files = async (request) => {
                if (request.op === 'getInfo') return { exists: true, isDirectory: true, uri: request.uri };
                if (request.op === 'barrier') { waiting = true; await held; return null; }
                if (request.op === 'delete') { deleted.push(request.uri); return null; }
                if (request.op === 'syncParent') { deleted.push(`synced ${request.uri}`); return null; }
                return null;
            };
            const { contractHost } = createNativeAttachments({
                storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
                getSecureConfigValue: async () => null,
                log: { info: () => {}, warn: () => {}, sanitize: (text) => text },
                crypto: {}, encryption: { logSyncEncryptionEvent: () => {}, getSyncEncryptionMaterial: async () => null },
            }, { files, installer: async () => null, directories: { document, cache: 'file:///data/user/0/app/cache/' },
                deleteNow: (uri) => { deleted.push(uri); } });
            let restored = false;
            const attachment = { id: 'a1', kind: 'file', title: 'a1.pdf', uri: `${document}attachments/a1.pdf`, createdAt: 't', updatedAt: 't' };
            const outcome = contractHost.deleteManagedAttachmentFile(attachment, { keep: () => restored });
            for (let step = 0; step < 200 && !waiting; step += 1) await new Promise((done) => setTimeout(done, 1));
            assert(waiting, 'the delete waits behind the file calls queued before it');
            if (restoreWhileWaiting) restored = true;
            release();
            return { result: await outcome, deleted };
        };
        assert.deepEqual(await deleteRace(true), { result: false, deleted: [] }, 'an attachment restored while its delete waited keeps its bytes');
        // The unlink in the turn that asked keep(), then the folder's sync on the files thread.
        assert.deepEqual(await deleteRace(false), { result: true, deleted: ['file:///data/user/0/app/files/attachments/a1.pdf',
            'synced file:///data/user/0/app/files/attachments/a1.pdf'] }, 'an unowned copy is deleted once, then its folder synced');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
// Task261: real pure V3 Discard candidate routing, without native cleanup authority.
{
    const AT = '2026-10-05T00:00:00.000Z', ROOT = 'file:///library/documents/attachments/';
    const baseline = { id: 'baseline261', kind: 'file', title: 'Retain', uri: ROOT + 'baseline.pdf', createdAt: AT, updatedAt: AT };
    const initial = JSON.stringify({ version: 2, taskID: 'task261', attachmentsOwned: true,
        attachmentsBase: [baseline], attachments: [baseline], raw: { notes: 'Opaque 文' } });
    const after = JSON.stringify({ ...JSON.parse(initial), attachments: [{ ...baseline, deletedAt: AT, updatedAt: AT }] });
    const removed = { version: 1, kind: 'prepared-file-remove', taskID: 'task261', requestId: '26100000-0000-4000-8000-000000000001',
        attachmentId: baseline.id, removedAt: AT, beforePayloadJSON: initial, afterPayloadJSON: after };
    const input = { version: 2, historyVersion: 3, taskID: 'task261', managedDirectoryURI: ROOT, initialPayloadJSON: initial,
        checkpointPayloadJSON: after, operations: [{ kind: 'remove', phase: 'checkpointed', preparedJSON: JSON.stringify(removed) }] };
    const expected = { ok: true, value: { version: 2, kind: 'owned-mixed-discard-candidates', taskID: 'task261', historyVersion: 3, candidates: [] } };
    const historical = makeState(0, [], 'ios'); historical.localTaskReadOnly = true;
    historical.sandbox = true; historical.workspaceTransition = true; historical.persistenceFailure = { private: 'not a historical gate' };
    vm.runInNewContext(`globalThis.Date = class extends Date {
        constructor(...args) { if (!args.length) throw new Error('fresh clock forbidden'); super(...args); }
    };`, historical);
    const ticket = historical.MindwtrHost.attachmentDraftDiscardCandidatesV3(JSON.stringify(input));
    assert.match(ticket, /^[1-9]\d*$/, 'mixed candidates retain Promise-ticket transport');
    assert.deepEqual(await poll(historical, ticket), expected, 'before boot and after capability loss, retained baseline Remove grants no cleanup candidate');
    assert.deepEqual(historical.events, []); assert.deepEqual(historical.fileCalls, []); assert.equal(historical.logText ?? '', '');
    assert.deepEqual(await poll(historical, historical.MindwtrHost.attachmentDraftDiscardCandidatesV3('{private-content')), { ok: false, error: 'INVALID_INPUT' });
    assert.equal((await poll(historical, historical.MindwtrHost.attachmentDraftDiscardCandidates(JSON.stringify(input)))).ok, false, 'old grammar stays sealed');
    assert.equal((await poll(historical, historical.MindwtrHost.attachmentDraftDiscardCandidatesV3(JSON.stringify({ ...input, version: 1, historyVersion: 2 })))).ok, false);
    const android = makeState(0);
    assert.match((await poll(android, android.MindwtrHost.attachmentDraftDiscardCandidatesV3('{}'))).error, /^NOT_READY:/);
    assert.equal((await poll(historical, historical.MindwtrHost.attachmentRequest('attachmentDraftDiscardCandidatesV3', JSON.stringify(input)))).ok, false);
    assert.equal(historical.attachmentInputs.length, 0, 'private mixed candidates do not enter generic attachment commands');
    console.log('Task261: real pure mixed Discard candidates retain iOS-only historical routing, sealed grammar and no generic file-command admission (NodeVM)');
}
console.log('Boot gates, second-read failure, failed-save refresh and editor read, and diagnostic acknowledgment passed');
