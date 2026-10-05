/**
 * Host APIs the core expects that a plain ECMAScript engine does not have.
 *
 * This file is loaded BEFORE the core bundle. It is plain ES2020 so QuickJS can
 * run it as-is. Every polyfill counts its own use, so the experiment can report
 * which host APIs the core really touches (`__hostUse`).
 *
 * Rule from the repo: never construct TextEncoder/TextDecoder at module scope.
 * Only the classes are defined here; nothing is instantiated.
 */
(function installHostPolyfills(global) {
    // Startup trace sections (Android's trace bridge call; absent elsewhere): this file's run, then the bundle's init, which
    // the last line of host-entry.ts closes.
    var tracer = global.__mindwtrNative && typeof global.__mindwtrNative.trace === 'function' ? global.__mindwtrNative : null;
    if (tracer) tracer.trace('js:polyfills');
    // A trace section around [work] (sync profiling: a large fetch body's bridge crossing and decoding).
    var traced = function (name, work) {
        if (!tracer) return work();
        tracer.trace(name);
        try { return work(); } finally { tracer.trace(''); }
    };
    var used = Object.create(null);
    var mark = function (name) { used[name] = (used[name] || 0) + 1; };
    global.__hostUse = used;

    var native = function () {
        var bridge = global.__mindwtrNative;
        if (!bridge) throw new Error('host bridge missing: globalThis.__mindwtrNative');
        return bridge;
    };

    // --- timers -------------------------------------------------------------
    // The engine has no event loop. Timers go in a table the host drains between
    // calls (`__pumpTimers`), so a debounced save still fires.
    var timers = new Map();
    var nextTimerId = 1;

    if (typeof global.setTimeout !== 'function') {
        global.setTimeout = function (fn, delay) {
            mark('setTimeout');
            var id = nextTimerId++;
            var args = Array.prototype.slice.call(arguments, 2);
            timers.set(id, { fn: fn, at: global.__nowMs() + (delay || 0), args: args, repeat: 0 });
            return id;
        };
        global.clearTimeout = function (id) { timers.delete(id); };
        global.setInterval = function (fn, delay) {
            mark('setInterval');
            var id = nextTimerId++;
            timers.set(id, { fn: fn, at: global.__nowMs() + (delay || 0), args: [], repeat: delay || 1 });
            return id;
        };
        global.clearInterval = function (id) { timers.delete(id); };
    }

    // --- host calls ---------------------------------------------------------
    // fetch and the secret calls run in the Android host, off the engine thread
    // (HostIo.kt). Each call's answer waits in the host's queue until the pump
    // below takes it (`ioNext`), so a promise settles where a timer fires.
    var NATIVE_ERROR = '!MindwtrNativeError:';
    var hostCall = function (value) {
        if (typeof value === 'string' && value.indexOf(NATIVE_ERROR) === 0) throw new TypeError(value.slice(NATIVE_ERROR.length));
        return value;
    };
    // Each open call's `settle` (its answer) and, for a fetch, `cancel` (a rejection with the reason, and the host's cancel).
    var ioPending = new Map();
    // Calls started and not yet answered, cancelled ones included: the pump asks the host only while one is open.
    var ioOpen = 0;
    var startIo = function (id, settle, cancel) {
        ioOpen += 1;
        ioPending.set(String(id), { settle: settle, cancel: cancel });
        return String(id);
    };
    // A bounded turn (CoreHost.idlePump, D9) stops taking answers and timers once its budget is spent; __pumpMore then says
    // whether any was left for the next turn.
    var turnEnd = Infinity;
    var turnCut = false;
    var turnSpent = function () {
        if (turnEnd === Infinity || global.__nowMs() < turnEnd) return false;
        turnCut = true;
        return true;
    };
    var pumpIo = function () {
        var settled = 0;
        while (ioOpen > 0 && !turnSpent()) {
            var text;
            try { text = hostCall(native().ioNext()); } catch (error) { global.__hostLog('host call error: ' + error); break; }
            if (!text) break;
            ioOpen -= 1;
            var answer = JSON.parse(text);
            // The body comes apart from its answer, so no copy of it is wrapped in JSON: base64, or a fetch body's text when the
            // host found it strict UTF-8 (`utf8`, HostIo.read) and decoded it off this thread.
            if (answer.body) {
                var payload = traced('io:body', function () { return hostCall(native().ioBody()); });
                if (answer.utf8) answer.utf8Text = payload; else answer.base64 = payload;
            }
            var entry = ioPending.get(answer.id);
            ioPending.delete(answer.id);
            // A cancelled call's late answer has no promise left to settle.
            if (!entry) continue;
            try { entry.settle(answer); } catch (error) { global.__hostLog('host call error: ' + error); }
            settled += 1;
        }
        return settled;
    };
    // The host's deadline passed (CoreHost.callAsync): every open fetch rejects with an AbortError and is cancelled, and a
    // new fetch or secret call is refused until __resumeHostCalls, so the timed-out operation drains without any IO.
    var refusing = null;
    var refuseIfCancelled = function () {
        if (refusing !== null) throw namedError('AbortError', refusing);
    };
    global.__cancelHostCalls = function (message) {
        refusing = String(message);
        ioPending.forEach(function (entry) { if (entry.cancel) entry.cancel(namedError('AbortError', refusing)); });
    };
    global.__resumeHostCalls = function () { refusing = null; };

    /**
     * Settles every host call already answered, then runs every timer already due. Returns how many of both. With [budgetMs],
     * one bounded turn: it takes nothing more once that much time has passed (the first item always runs).
     */
    global.__pumpTimers = function (budgetMs) {
        turnCut = false;
        turnEnd = typeof budgetMs === 'number' ? global.__nowMs() + budgetMs : Infinity;
        var ran = 0;
        try {
            ran = pumpIo();
            var now = global.__nowMs();
            var due = [];
            timers.forEach(function (timer, id) { if (timer.at <= now) due.push([id, timer]); });
            due.sort(function (a, b) { return a[1].at - b[1].at; });
            for (var i = 0; i < due.length && !(ran > 0 && turnSpent()); i += 1) {
                var id = due[i][0];
                var timer = due[i][1];
                if (timer.repeat > 0) timer.at = now + timer.repeat; else timers.delete(id);
                try { timer.fn.apply(null, timer.args); } catch (error) { global.__hostLog('timer error: ' + error); }
                ran += 1;
            }
        } finally {
            turnEnd = Infinity;
        }
        return ran;
    };

    /** Whether the last bounded turn left answers or timers it had no time for. */
    global.__pumpMore = function () { return turnCut; };

    /** Milliseconds until the next timer is due, or -1 when none is waiting. */
    global.__nextTimerDelay = function () {
        var soonest = -1;
        var now = global.__nowMs();
        timers.forEach(function (timer) {
            var wait = Math.max(0, timer.at - now);
            if (soonest < 0 || wait < soonest) soonest = wait;
        });
        return soonest;
    };

    // --- clock and logging --------------------------------------------------
    global.__nowMs = function () { return native().nowMs(); };
    global.__hostLog = function (line) { native().log(String(line)); };

    if (typeof global.performance !== 'object' || typeof global.performance.now !== 'function') {
        global.performance = { now: function () { mark('performance.now'); return global.__nowMs(); } };
    }

    // --- crypto -------------------------------------------------------------
    if (typeof global.crypto !== 'object' || !global.crypto) global.crypto = {};
    if (typeof global.crypto.getRandomValues !== 'function') {
        global.crypto.getRandomValues = function (array) {
            mark('crypto.getRandomValues');
            var bytes = JSON.parse(native().randomBytes(array.length));
            for (var i = 0; i < array.length; i += 1) array[i] = bytes[i];
            return array;
        };
    }
    if (typeof global.crypto.randomUUID !== 'function') {
        global.crypto.randomUUID = function () {
            mark('crypto.randomUUID');
            var bytes = new Uint8Array(16);
            global.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            var hex = '';
            for (var i = 0; i < 16; i += 1) hex += (bytes[i] + 0x100).toString(16).slice(1);
            return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
                + hex.slice(16, 20) + '-' + hex.slice(20);
        };
    }

    // --- text encoding ------------------------------------------------------
    // UTF-8 only. A lone surrogate encodes as U+FFFD, as the platform's does.
    if (typeof global.TextEncoder !== 'function') {
        global.TextEncoder = function TextEncoder() { };
        global.TextEncoder.prototype.encode = function (input) {
            mark('TextEncoder');
            var text = String(input == null ? '' : input);
            var bytes = [];
            for (var i = 0; i < text.length; i += 1) {
                var code = text.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdfff) {
                    var low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
                    if (code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
                        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                        i += 1;
                    } else {
                        code = 0xfffd;
                    }
                }
                if (code < 0x80) bytes.push(code);
                else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
                else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
                else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
            return new Uint8Array(bytes);
        };
    }
    // The platform's UTF-8 decoder, with one difference on purpose: a decoder made without options is fatal (malformed
    // UTF-8 throws a TypeError). Core reads every response as text through `new TextDecoder()`, and a body that decoded
    // to replacement or wrong characters (E2 alone once read as U+2000, a space) could trim to empty and read as a
    // missing remote document, which sync writes over. `{ fatal: false }` replaces each malformed sequence with U+FFFD.
    if (typeof global.TextDecoder !== 'function') {
        global.TextDecoder = function TextDecoder(_label, options) {
            this.encoding = 'utf-8';
            this.fatal = !(options && options.fatal === false);
        };
        global.TextDecoder.prototype.decode = function (input) {
            mark('TextDecoder');
            if (!input) return '';
            var bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
            var fatal = this.fatal;
            var parts = [];
            var units = [];
            var needed = 0;
            var seen = 0;
            var code = 0;
            var lower = 0x80;
            var upper = 0xbf;
            var malformed = function () {
                if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
                units.push(0xfffd);
            };
            for (var i = 0; i < bytes.length; i += 1) {
                var byte = bytes[i];
                if (needed === 0) {
                    if (byte <= 0x7f) {
                        units.push(byte);
                    } else if (byte >= 0xc2 && byte <= 0xdf) {
                        needed = 1;
                        code = byte & 0x1f;
                    } else if (byte >= 0xe0 && byte <= 0xef) {
                        if (byte === 0xe0) lower = 0xa0;
                        if (byte === 0xed) upper = 0x9f;
                        needed = 2;
                        code = byte & 0x0f;
                    } else if (byte >= 0xf0 && byte <= 0xf4) {
                        if (byte === 0xf0) lower = 0x90;
                        if (byte === 0xf4) upper = 0x8f;
                        needed = 3;
                        code = byte & 0x07;
                    } else {
                        malformed();
                    }
                } else if (byte < lower || byte > upper) {
                    // The sequence ends here; this byte starts over (the platform's maximal-subpart rule).
                    needed = seen = code = 0;
                    lower = 0x80;
                    upper = 0xbf;
                    malformed();
                    i -= 1;
                } else {
                    lower = 0x80;
                    upper = 0xbf;
                    code = (code << 6) | (byte & 0x3f);
                    seen += 1;
                    if (seen === needed) {
                        if (code > 0xffff) units.push(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff));
                        else units.push(code);
                        needed = seen = code = 0;
                    }
                }
                if (units.length >= 8192) {
                    parts.push(String.fromCharCode.apply(null, units));
                    units = [];
                }
            }
            if (needed !== 0) malformed();
            parts.push(String.fromCharCode.apply(null, units));
            return parts.join('');
        };
    }

    // --- structuredClone ----------------------------------------------------
    if (typeof global.structuredClone !== 'function') {
        global.structuredClone = function (value) {
            mark('structuredClone');
            var seen = new Map();
            var clone = function (input) {
                if (input === null || typeof input !== 'object') return input;
                if (seen.has(input)) return seen.get(input);
                if (input instanceof Date) return new Date(input.getTime());
                if (input instanceof Map) {
                    var map = new Map();
                    seen.set(input, map);
                    input.forEach(function (v, k) { map.set(clone(k), clone(v)); });
                    return map;
                }
                if (input instanceof Set) {
                    var set = new Set();
                    seen.set(input, set);
                    input.forEach(function (v) { set.add(clone(v)); });
                    return set;
                }
                if (Array.isArray(input)) {
                    var list = [];
                    seen.set(input, list);
                    for (var i = 0; i < input.length; i += 1) list.push(clone(input[i]));
                    return list;
                }
                if (ArrayBuffer.isView(input)) return input.slice();
                var copy = {};
                seen.set(input, copy);
                Object.keys(input).forEach(function (key) { copy[key] = clone(input[key]); });
                return copy;
            };
            return clone(value);
        };
    }

    // --- AbortController and AbortSignal ------------------------------------
    // What core and fetch use: abort with a reason (an AbortError without one),
    // AbortSignal.abort and AbortSignal.timeout (a TimeoutError, on the host's
    // timers), throwIfAborted, onabort, and abort listeners, each run once.
    var namedError = function (name, message) {
        var error = new Error(message);
        error.name = name;
        return error;
    };
    if (typeof global.AbortController !== 'function') {
        var AbortSignal = function AbortSignal() { throw new TypeError('Illegal constructor'); };
        var createSignal = function () {
            var signal = Object.create(AbortSignal.prototype);
            signal.aborted = false;
            signal.reason = undefined;
            signal.onabort = null;
            signal._listeners = [];
            return signal;
        };
        var abortSignal = function (signal, reason) {
            if (signal.aborted) return;
            signal.aborted = true;
            signal.reason = reason === undefined ? namedError('AbortError', 'This operation was aborted') : reason;
            var listeners = signal._listeners;
            signal._listeners = [];
            var event = { type: 'abort', target: signal };
            if (typeof signal.onabort === 'function') listeners.unshift(signal.onabort);
            listeners.forEach(function (fn) { try { fn.call(signal, event); } catch (e) { } });
        };
        AbortSignal.prototype.addEventListener = function (type, fn) {
            if (type === 'abort' && typeof fn === 'function' && !this.aborted && this._listeners.indexOf(fn) < 0) this._listeners.push(fn);
        };
        AbortSignal.prototype.removeEventListener = function (type, fn) {
            var at = this._listeners.indexOf(fn);
            if (type === 'abort' && at >= 0) this._listeners.splice(at, 1);
        };
        AbortSignal.prototype.throwIfAborted = function () { if (this.aborted) throw this.reason; };
        AbortSignal.abort = function (reason) {
            var signal = createSignal();
            abortSignal(signal, reason);
            return signal;
        };
        AbortSignal.timeout = function (ms) {
            var signal = createSignal();
            global.setTimeout(function () { abortSignal(signal, namedError('TimeoutError', 'The operation timed out.')); }, ms);
            return signal;
        };
        global.AbortSignal = AbortSignal;
        global.AbortController = function AbortController() {
            mark('AbortController');
            this.signal = createSignal();
        };
        global.AbortController.prototype.abort = function (reason) { abortSignal(this.signal, reason); };
    }

    // --- URL ----------------------------------------------------------------
    // Enough for the sync ports: scheme, host, port, path, query. Not a full
    // WHATWG URL parser; the report says so. A non-special scheme without "//"
    // (mailto:, tel:) has no host: its path is the rest, as the platform parses it.
    if (typeof global.URL !== 'function') {
        // Userinfo runs to the authority's LAST "@" (WHATWG): a password may hold an "@", and a log must never keep part of it.
        var URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^/?#]*)@)?([^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/;
        var OPAQUE_URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):([^?#]*)(\?[^#]*)?(#.*)?$/;
        var SPECIAL_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file'];
        global.URL = function URL(input, base) {
            mark('URL');
            var text = String(input);
            if (base && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
                var baseText = String(base).replace(/[?#].*$/, '');
                text = text.charAt(0) === '/'
                    ? baseText.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*).*$/, '$1') + text
                    : baseText.replace(/[^/]*$/, '') + text;
            }
            var parts = URL_RE.exec(text);
            var opaque = parts ? null : OPAQUE_URL_RE.exec(text);
            if (opaque && SPECIAL_SCHEMES.indexOf(opaque[1].toLowerCase()) < 0) {
                this.protocol = opaque[1].toLowerCase() + ':';
                this.username = this.password = this.hostname = this.port = this.host = '';
                this.pathname = opaque[2];
                this.search = opaque[3] || '';
                this.hash = opaque[4] || '';
                this.origin = 'null';
                this.searchParams = new global.URLSearchParams(this.search);
                this._opaque = true;
                return;
            }
            if (!parts) throw new TypeError('Invalid URL: ' + input);
            this.protocol = parts[1].toLowerCase() + ':';
            // The password is everything after the first ":" of the userinfo.
            var credentials = parts[2] || '';
            var colon = credentials.indexOf(':');
            this.username = colon < 0 ? credentials : credentials.slice(0, colon);
            this.password = colon < 0 ? '' : credentials.slice(colon + 1);
            this.hostname = parts[3] || '';
            this.port = parts[4] || '';
            this.host = this.hostname + (this.port ? ':' + this.port : '');
            this.pathname = parts[5] || '/';
            this.search = parts[6] || '';
            this.hash = parts[7] || '';
            this.origin = this.protocol + '//' + this.host;
            this.searchParams = new global.URLSearchParams(this.search);
        };
        global.URL.prototype.toString = function () {
            var params = this.searchParams ? this.searchParams.toString() : null;
            var query = params === null ? this.search : params ? '?' + params : '';
            if (this._opaque) return this.protocol + this.pathname + query + this.hash;
            var credentials = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
            return this.protocol + '//' + credentials + this.host + this.pathname + query + this.hash;
        };
        global.URL.prototype.toJSON = function () { return this.toString(); };
    }

    if (typeof global.URLSearchParams !== 'function') {
        // A query name or value as WHATWG's form-urlencoded parser reads it (and RN's URL shim): "+" is a space.
        var decodeQuery = function (text) { return decodeURIComponent(text.replace(/\+/g, ' ')); };
        global.URLSearchParams = function URLSearchParams(init) {
            var pairs = [];
            if (typeof init === 'string') {
                init.replace(/^\?/, '').split('&').forEach(function (pair) {
                    if (!pair) return;
                    var at = pair.indexOf('=');
                    pairs.push(at < 0
                        ? [decodeQuery(pair), '']
                        : [decodeQuery(pair.slice(0, at)), decodeQuery(pair.slice(at + 1))]);
                });
            } else if (init && typeof init === 'object') {
                Object.keys(init).forEach(function (key) { pairs.push([key, String(init[key])]); });
            }
            this._pairs = pairs;
        };
        global.URLSearchParams.prototype.get = function (key) {
            for (var i = 0; i < this._pairs.length; i += 1) if (this._pairs[i][0] === key) return this._pairs[i][1];
            return null;
        };
        global.URLSearchParams.prototype.has = function (key) { return this.get(key) !== null; };
        // WHATWG: the first pair named [key] takes the value and every later one goes (core's sanitizer redacts a repeated token).
        global.URLSearchParams.prototype.set = function (key, value) {
            var found = false;
            this._pairs = this._pairs.filter(function (pair) {
                if (pair[0] !== key) return true;
                if (found) return false;
                found = true;
                pair[1] = String(value);
                return true;
            });
            if (!found) this._pairs.push([key, String(value)]);
        };
        global.URLSearchParams.prototype.append = function (key, value) { this._pairs.push([key, String(value)]); };
        global.URLSearchParams.prototype.delete = function (key) {
            this._pairs = this._pairs.filter(function (pair) { return pair[0] !== key; });
        };
        global.URLSearchParams.prototype.forEach = function (fn) {
            this._pairs.forEach(function (pair) { fn(pair[1], pair[0]); });
        };
        // Iterators over a copy, as WHATWG's (core's log sanitizer walks keys()).
        var pairIterator = function (pairs, pick) {
            var items = pairs.map(pick);
            var index = 0;
            var iterator = { next: function () { return index < items.length ? { value: items[index++], done: false } : { value: undefined, done: true }; } };
            if (typeof Symbol === 'function' && Symbol.iterator) iterator[Symbol.iterator] = function () { return iterator; };
            return iterator;
        };
        global.URLSearchParams.prototype.keys = function () { return pairIterator(this._pairs, function (pair) { return pair[0]; }); };
        global.URLSearchParams.prototype.values = function () { return pairIterator(this._pairs, function (pair) { return pair[1]; }); };
        global.URLSearchParams.prototype.entries = function () { return pairIterator(this._pairs, function (pair) { return [pair[0], pair[1]]; }); };
        if (typeof Symbol === 'function' && Symbol.iterator) global.URLSearchParams.prototype[Symbol.iterator] = global.URLSearchParams.prototype.entries;
        global.URLSearchParams.prototype.toString = function () {
            if (this._pairs.length === 0) return '';
            // A space goes out as "+", as WHATWG writes it, so a "+" the query came with survives String(url).
            var encodeQuery = function (text) { return encodeURIComponent(text).replace(/%20/g, '+'); };
            // No "?": WHATWG's serialization, which a form body and a caller's own "?" rely on.
            return this._pairs.map(function (pair) {
                return encodeQuery(pair[0]) + '=' + encodeQuery(pair[1]);
            }).join('&');
        };
    }

    // --- fetch --------------------------------------------------------------
    // RN's fetch as the Android host gives it (HostIo.kt, on OkHttp as RN's):
    // Headers, Request, Response with no stream body (core then reads through
    // arrayBuffer(), as from RN's background-safe fetch), and fetch itself. A
    // body crosses the bridge as text or base64 bytes; the answer's body comes
    // back as base64 and is decoded on first read.
    var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var base64Codes = null;
    var toBase64 = function (bytes) {
        var parts = [];
        var chunk = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) | (i + 2 < bytes.length ? bytes[i + 2] : 0);
            chunk += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
                + (i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '=') + (i + 2 < bytes.length ? BASE64.charAt(n & 63) : '=');
            if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
        }
        parts.push(chunk);
        return parts.join('');
    };
    // Strict: text that is not whole base64 throws, so a damaged answer can never read as a shorter body.
    var fromBase64 = function (text) {
        var unreadable = function () { return new TypeError('Network request failed: the host sent an unreadable body'); };
        if (typeof text !== 'string' || text.length % 4 !== 0) throw unreadable();
        if (!base64Codes) {
            base64Codes = new Uint8Array(128).fill(255);
            for (var c = 0; c < 64; c += 1) base64Codes[BASE64.charCodeAt(c)] = c;
            base64Codes[61] = 0;
        }
        var padding = text.charAt(text.length - 1) === '=' ? (text.charAt(text.length - 2) === '=' ? 2 : 1) : 0;
        var firstPad = text.indexOf('=');
        if (firstPad >= 0 && firstPad < text.length - padding) throw unreadable();
        var bytes = new Uint8Array((text.length / 4) * 3 - padding);
        for (var i = 0, j = 0; i < text.length; i += 4) {
            var a = text.charCodeAt(i);
            var b = text.charCodeAt(i + 1);
            var d = text.charCodeAt(i + 2);
            var e = text.charCodeAt(i + 3);
            if ((a | b | d | e) > 127) throw unreadable();
            a = base64Codes[a];
            b = base64Codes[b];
            d = base64Codes[d];
            e = base64Codes[e];
            if ((a | b | d | e) > 63) throw unreadable();
            var n = (a << 18) | (b << 12) | (d << 6) | e;
            bytes[j++] = (n >> 16) & 255;
            if (j < bytes.length) bytes[j++] = (n >> 8) & 255;
            if (j < bytes.length) bytes[j++] = n & 255;
        }
        return bytes;
    };
    var bytesOf = function (body) {
        if (body instanceof ArrayBuffer) return new Uint8Array(body);
        if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        throw new TypeError('Unsupported body: text, URLSearchParams, ArrayBuffer or a typed array only');
    };

    var HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    var headerName = function (name) {
        var text = String(name);
        if (!HEADER_NAME.test(text)) throw new TypeError('Invalid header name: ' + text);
        return text.toLowerCase();
    };
    var headerValue = function (value) {
        var text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
        if (/[\0\r\n]/.test(text)) throw new TypeError('Invalid header value');
        return text;
    };
    if (typeof global.Headers !== 'function') {
        global.Headers = function Headers(init) {
            var self = this;
            this._map = new Map();
            if (init instanceof global.Headers) {
                init.forEach(function (value, name) { self.append(name, value); });
            } else if (Array.isArray(init)) {
                init.forEach(function (pair) {
                    if (!pair || pair.length !== 2) throw new TypeError('A header needs a name and a value');
                    self.append(pair[0], pair[1]);
                });
            } else if (init && typeof init === 'object') {
                Object.keys(init).forEach(function (name) { self.append(name, init[name]); });
            }
        };
        var headersProto = global.Headers.prototype;
        headersProto.append = function (name, value) {
            var key = headerName(name);
            var text = headerValue(value);
            var current = this._map.get(key);
            this._map.set(key, current === undefined ? text : current + ', ' + text);
        };
        headersProto.set = function (name, value) { this._map.set(headerName(name), headerValue(value)); };
        headersProto.get = function (name) {
            var value = this._map.get(headerName(name));
            return value === undefined ? null : value;
        };
        headersProto.has = function (name) { return this._map.has(headerName(name)); };
        headersProto.delete = function (name) { this._map.delete(headerName(name)); };
        // Names in order, as the platform's Headers iterates.
        headersProto._pairs = function () {
            var pairs = [];
            this._map.forEach(function (value, name) { pairs.push([name, value]); });
            return pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
        };
        headersProto.forEach = function (fn, thisArg) {
            var self = this;
            this._pairs().forEach(function (pair) { fn.call(thisArg, pair[1], pair[0], self); });
        };
        headersProto.entries = function () { return this._pairs()[Symbol.iterator](); };
        headersProto.keys = function () { return this._pairs().map(function (pair) { return pair[0]; })[Symbol.iterator](); };
        headersProto.values = function () { return this._pairs().map(function (pair) { return pair[1]; })[Symbol.iterator](); };
        headersProto[Symbol.iterator] = headersProto.entries;
    }

    // WebDAV's methods and the usual ones. Upper-cased, as RN's background-safe fetch sends them.
    var METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'PROPFIND', 'MKCOL', 'MOVE', 'COPY'];
    if (typeof global.Request !== 'function') {
        global.Request = function Request(input, init) {
            var options = init || {};
            var source = input instanceof global.Request ? input : null;
            this.url = source ? source.url : String(input);
            this.method = String(options.method || (source ? source.method : 'GET')).toUpperCase();
            if (METHODS.indexOf(this.method) < 0) throw new TypeError('Unsupported method: ' + this.method);
            this.headers = new global.Headers(options.headers || (source ? source.headers : undefined));
            this.signal = options.signal || (source ? source.signal : null) || new global.AbortController().signal;
            this.redirect = options.redirect || (source ? source.redirect : 'follow');
            var body = options.body !== undefined ? options.body : (source ? source._body : null);
            if (body != null && (this.method === 'GET' || this.method === 'HEAD')) {
                throw new TypeError('Request with GET/HEAD method cannot have body.');
            }
            this._body = body == null ? null : body;
        };
    }

    if (typeof global.Response !== 'function') {
        global.Response = function Response(body, init) {
            var options = init || {};
            this.status = options.status === undefined ? 200 : options.status;
            this.statusText = options.statusText === undefined ? '' : String(options.statusText);
            this.ok = this.status >= 200 && this.status < 300;
            this.headers = new global.Headers(options.headers);
            this.url = '';
            this.redirected = false;
            this.type = 'default';
            this.body = null;
            this.bodyUsed = false;
            this._bytes = body == null ? new Uint8Array(0) : typeof body === 'string' ? new global.TextEncoder().encode(body) : bytesOf(body).slice();
        };
        // A fetch body the host decoded keeps only its text until someone asks for bytes: valid UTF-8 encodes back exactly.
        var readBody = function (response) {
            response.bodyUsed = true;
            if (response._bytes === undefined) response._bytes = new global.TextEncoder().encode(response._text);
            return response._bytes;
        };
        var responseProto = global.Response.prototype;
        responseProto.arrayBuffer = function () {
            var bytes = readBody(this);
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        };
        responseProto.bytes = function () { return Promise.resolve(readBody(this).slice()); };
        // Fatal: a body that is not UTF-8 rejects rather than reading as other text.
        responseProto.text = function () {
            var response = this;
            if (response._text !== undefined) {
                response.bodyUsed = true;
                return Promise.resolve(response._text);
            }
            return new Promise(function (resolve) { resolve(new global.TextDecoder('utf-8', { fatal: true }).decode(readBody(response))); });
        };
        responseProto.json = function () { return this.text().then(function (text) { return JSON.parse(text); }); };
        responseProto.clone = function () {
            var copy = new global.Response(null, { status: this.status, statusText: this.statusText, headers: this.headers });
            copy.url = this.url;
            copy.redirected = this.redirected;
            copy.type = this.type;
            copy._bytes = this._bytes;
            copy._text = this._text;
            copy.mindwtrDecodedTextBytes = this.mindwtrDecodedTextBytes;
            return copy;
        };
    }

    if (typeof global.fetch !== 'function') {
        global.fetch = function (input, init) {
            mark('fetch');
            return new Promise(function (resolve, reject) {
                var request = new global.Request(input, init);
                var signal = request.signal;
                if (signal.aborted) throw signal.reason;
                refuseIfCancelled();
                var payload = { url: request.url, method: request.method, redirect: request.redirect };
                var body = request._body;
                if (typeof body === 'string' || body instanceof global.URLSearchParams) {
                    if (!request.headers.has('content-type')) {
                        request.headers.set('content-type', typeof body === 'string'
                            ? 'text/plain;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8');
                    }
                    payload.text = typeof body === 'string' ? body : body.toString();
                } else if (body !== null) {
                    payload.base64 = toBase64(bytesOf(body));
                }
                payload.headers = [];
                request.headers.forEach(function (value, name) { payload.headers.push([name, value]); });
                // The host answers with the whole body or an error (a body cut short, reset, oversized or undecodable is
                // an error, HostIo.read): fetch then rejects. It never resolves with a partial or empty body, which core
                // would read as a missing remote document and write over.
                var cancel = function (reason) {
                    signal.removeEventListener('abort', onAbort);
                    ioPending.delete(id);
                    try { native().netAbort(id); } catch (_error) { /* its late answer is dropped either way */ }
                    reject(reason);
                };
                var onAbort = function () { cancel(signal.reason); };
                var id = startIo(traced('io:fetchStart', function () { return hostCall(native().netFetch(JSON.stringify(payload))); }), function (answer) {
                    signal.removeEventListener('abort', onAbort);
                    try {
                        if (answer.error !== undefined) throw new TypeError(answer.error);
                        var response = new global.Response(null, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
                        response.url = answer.url;
                        response.redirected = answer.redirected;
                        response.type = 'basic';
                        if (answer.utf8) {
                            // Core's readDecodedResponseText (http-utils.ts) reads this text under its byte limit.
                            response._text = answer.utf8Text;
                            response._bytes = undefined;
                            response.mindwtrDecodedTextBytes = answer.bytes;
                        } else {
                            response._bytes = traced('io:fromBase64', function () { return fromBase64(answer.base64); });
                        }
                        resolve(response);
                    } catch (error) {
                        reject(error);
                    }
                }, cancel);
                signal.addEventListener('abort', onAbort);
            });
        };
    }

    // --- secrets ------------------------------------------------------------
    // The host's secure storage (SecretStore.kt: RN's expo-secure-store items in
    // the Android Keystore, under RN's key names), for the credentials core's
    // sync and AI settings keep. Each call runs off the engine thread.
    var secretCall = function (op, key, value, refuse) {
        return new Promise(function (resolve, reject) {
            if (refuse) refuseIfCancelled();
            startIo(hostCall(native().secretCall(JSON.stringify({ op: op, key: String(key), value: value }))), function (answer) {
                if (answer.error !== undefined) reject(new Error(answer.error));
                else resolve(op === 'get' ? answer.value : undefined);
            });
        });
    };
    var secrets = function (refuse) {
        return {
            /** The value saved under [key], or null. */
            getSecret: function (key) { mark('secrets'); return secretCall('get', key, undefined, refuse); },
            setSecret: function (key, value) {
                mark('secrets');
                if (typeof value !== 'string') return Promise.reject(new TypeError('A secret value must be a string'));
                return secretCall('set', key, value, refuse);
            },
            deleteSecret: function (key) { mark('secrets'); return secretCall('delete', key, undefined, refuse); },
        };
    };
    global.__mindwtrSecrets = secrets(true);
    // Sync's (host-sync.ts), never refused while another call drains: a Save's commit refused half-way leaves sync off,
    // and a keystore call answers at once, so the timed-out call still ends.
    global.__mindwtrSyncSecrets = secrets(false);

    // --- files --------------------------------------------------------------
    // Core's attachment file port and RN's installer (host-attachments.ts) on the host's app-private files (HostFiles.kt,
    // HostInstaller.kt): each call runs off the engine thread, one at a time in call order, and settles where a timer fires.
    // `request` is `{ op, ... }`; `bytes` a write's bytes. It answers the call's value, or a read's bytes; a failure rejects
    // with the host's text (a missing file names ENOENT). Refused once the host's deadline passed, as a fetch is, and an open
    // call then rejects at once and the host aborts it (HostIo.fileAbort: a copy stalled on a document provider), so a
    // timed-out operation drains and the host never stops; its late answer settles nothing.
    var fileChannel = function (method) {
        return function (request, bytes) {
            return new Promise(function (resolve, reject) {
                refuseIfCancelled();
                var payload = {};
                for (var key in request) if (Object.prototype.hasOwnProperty.call(request, key)) payload[key] = request[key];
                if (bytes !== undefined) payload.base64 = toBase64(bytesOf(bytes));
                var cancel = function (reason) {
                    ioPending.delete(id);
                    try { native().fileAbort(id); } catch (_error) { /* its late answer is dropped either way */ }
                    reject(reason);
                };
                var id = startIo(hostCall(native()[method](JSON.stringify(payload))), function (answer) {
                    if (answer.error !== undefined) reject(new Error(answer.error));
                    else resolve(answer.body ? fromBase64(answer.base64) : answer.value);
                }, cancel);
            });
        };
    };
    if (global.__mindwtrNative && typeof global.__mindwtrNative.fileCall === 'function') {
        global.__mindwtrFileCall = fileChannel('fileCall');
        global.__mindwtrInstallerCall = fileChannel('installerCall');
    }

    // --- sync crypto --------------------------------------------------------
    // Sync encryption's Argon2id and AES-256-GCM (HostCrypto.kt, through host-sync.ts): each call runs on the host's crypto
    // thread, never the engine's, and settles where a timer fires. `request` is `{ op, ... }` with its bytes as Uint8Arrays;
    // it answers the result's bytes. A GCM tag or AAD mismatch rejects with `code: 'auth'`. Never refused once the host's
    // deadline passed: it does no IO and always answers, so the timed-out call still drains.
    if (global.__mindwtrNative && typeof global.__mindwtrNative.cryptoCall === 'function') {
        global.__mindwtrCryptoCall = function (request) {
            return new Promise(function (resolve, reject) {
                mark('crypto');
                var payload = {};
                for (var key in request) {
                    if (!Object.prototype.hasOwnProperty.call(request, key)) continue;
                    var value = request[key];
                    payload[key] = ArrayBuffer.isView(value) ? toBase64(bytesOf(value)) : value;
                }
                startIo(hostCall(native().cryptoCall(JSON.stringify(payload))), function (answer) {
                    if (answer.error === undefined) { resolve(fromBase64(answer.base64)); return; }
                    var error = new Error(answer.error);
                    if (answer.auth) error.code = 'auth';
                    reject(error);
                });
            });
        };
    }

    // --- localStorage -------------------------------------------------------
    // In-memory only. The core stores the chosen language here; the experiment
    // never relies on it surviving a restart.
    if (typeof global.localStorage !== 'object' || !global.localStorage) {
        var store = Object.create(null);
        global.localStorage = {
            getItem: function (key) { mark('localStorage'); return key in store ? store[key] : null; },
            setItem: function (key, value) { mark('localStorage'); store[key] = String(value); },
            removeItem: function (key) { delete store[key]; },
            clear: function () { store = Object.create(null); },
        };
    }

    // --- Intl ---------------------------------------------------------------
    // QuickJS has no Intl at all, and `packages/core/src/task-utils.ts` builds
    // three Intl.Collator objects while the bundle is being evaluated, so the
    // bundle does not even load without this. The Android host gives ICU
    // collation keys (`__mindwtrNative.collationKey`, the device locale's
    // collator, as Hermes uses), so titles sort as in RN; without that bridge
    // the plain comparison below is a fallback, not ICU.
    if (typeof global.Intl !== 'object' || !global.Intl) {
        var WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        var pad2 = function (value) { return (value < 10 ? '0' : '') + value; };

        // One key per text and options, kept until 20000 are held (a sort compares the same titles many times).
        var collationKeys = Object.create(null);
        var collationKeyCount = 0;
        var collationKey = function (native, text, options) {
            var id = options + '|' + text;
            var key = collationKeys[id];
            if (key === undefined) {
                if (collationKeyCount >= 20000) { collationKeys = Object.create(null); collationKeyCount = 0; }
                key = String(native.collationKey(text, options));
                collationKeys[id] = key;
                collationKeyCount += 1;
            }
            return key;
        };
        var Collator = function Collator(_locales, options) {
            mark('Intl.Collator');
            var numeric = !!(options && options.numeric);
            var base = !!(options && options.sensitivity === 'base');
            var sensitivity = (options && options.sensitivity) || 'variant';
            var icuOptions = sensitivity + ':' + (numeric ? '1' : '0');
            this.compare = function (a, b) {
                var left = String(a);
                var right = String(b);
                var native = global.__mindwtrNative;
                if (native && typeof native.collationKey === 'function') {
                    var leftKey = collationKey(native, left, icuOptions);
                    var rightKey = collationKey(native, right, icuOptions);
                    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
                }
                if (base) { left = left.toLowerCase(); right = right.toLowerCase(); }
                if (numeric) {
                    var leftParts = left.match(/(\d+|\D+)/g) || [];
                    var rightParts = right.match(/(\d+|\D+)/g) || [];
                    for (var i = 0; i < Math.min(leftParts.length, rightParts.length); i += 1) {
                        var lp = leftParts[i];
                        var rp = rightParts[i];
                        var bothNumbers = /^\d/.test(lp) && /^\d/.test(rp);
                        if (bothNumbers) {
                            var diff = Number(lp) - Number(rp);
                            if (diff !== 0) return diff < 0 ? -1 : 1;
                        } else if (lp !== rp) {
                            return lp < rp ? -1 : 1;
                        }
                    }
                    return leftParts.length - rightParts.length;
                }
                if (left === right) return 0;
                return left < right ? -1 : 1;
            };
        };
        Collator.prototype.resolvedOptions = function () { return { locale: 'en' }; };
        // Hermes's localeCompare is its Intl.Collator; QuickJS's compares code points.
        Object.defineProperty(String.prototype, 'localeCompare', {
            value: function localeCompare(that, locales, options) { return new Collator(locales, options).compare(String(this), String(that)); },
            writable: true, configurable: true, enumerable: false,
        });

        // Intl.DateTimeFormat and Date's toLocale*String, as Hermes gives them on Android: the host's `dateTimeFormat`
        // (IcuDateTimeFormat.kt) resolves and formats with Android's ICU as Hermes's Java does; this side does Hermes's
        // C++ part (Intl.cpp): read the locales and the options, apply toLocale*String's defaults, TimeClip the date.
        // Without that bridge (a Node VM gate) the English stand-in below is a fallback, not ICU.
        var dateBridge = function () {
            var bridge = global.__mindwtrNative;
            return bridge && typeof bridge.dateTimeFormat === 'function' ? bridge : null;
        };
        var askDates = function (bridge, spec, op, time) {
            var value = bridge.dateTimeFormat(spec, op, time);
            // Hermes turns every Java failure into a RangeError.
            if (typeof value === 'string' && value.indexOf(NATIVE_ERROR) === 0) throw new RangeError(value.slice(NATIVE_ERROR.length));
            return value;
        };
        // Hermes's kDTFOptions, in its order: hour12 is a boolean, fractionalSecondDigits a number, the rest strings.
        var DATE_OPTIONS = ['localeMatcher', 'calendar', 'numberingSystem', 'hour12', 'hourCycle', 'timeZone', 'formatMatcher', 'weekday', 'era',
            'year', 'month', 'dayPeriod', 'day', 'hour', 'minute', 'second', 'timeZoneName', 'dateStyle', 'timeStyle', 'fractionalSecondDigits'];
        var DATE_FIELDS = ['weekday', 'year', 'month', 'day'];
        var TIME_FIELDS = ['hour', 'minute', 'second'];
        var readLocales = function (locales) {
            if (locales === undefined) return [];
            if (typeof locales === 'string') return [locales];
            if (locales === null) throw new TypeError('Cannot convert null to object');
            var list = Object(locales);
            var length = Math.min(Math.max(Math.floor(Number(list.length)) || 0, 0), 9007199254740991);
            var out = [];
            for (var i = 0; i < length; i += 1) {
                var item = list[i];
                if (typeof item !== 'string' && (item === null || (typeof item !== 'object' && typeof item !== 'function'))) throw new TypeError('Incorrect object type');
                out.push(String(item));
            }
            return out;
        };
        var readDateOptions = function (options) {
            if (options === null) throw new TypeError("Options object can't be null !");
            var out = {};
            if (typeof options !== 'object' && typeof options !== 'function') return out;
            DATE_OPTIONS.forEach(function (name) {
                var value = options[name];
                if (value === undefined) return;
                out[name] = name === 'hour12' ? Boolean(value) : name === 'fractionalSecondDigits' ? Number(value) : String(value);
            });
            return out;
        };
        var has = function (options, names) { return names.some(function (name) { return options[name] !== undefined; }); };
        var timeValue = function (date) {
            var time = date === undefined ? Date.now() : Number(date);
            if (!isFinite(time) || Math.abs(time) > 8.64e15) throw new RangeError('Invalid time value');
            return Math.trunc(time) + 0;
        };
        var getTime = Date.prototype.getTime;
        // Date.prototype.toLocale*String: Hermes's toDateTimeOptions, then a formatter for these locales and options.
        [['toLocaleString', true, true], ['toLocaleDateString', true, false], ['toLocaleTimeString', false, true]].forEach(function (entry) {
            var own = Date.prototype[entry[0]];
            var date = entry[1];
            var time = entry[2];
            var toLocale = function (locales, options) {
                mark('Date.' + entry[0]);
                var bridge = dateBridge();
                if (!bridge) return own.apply(this, arguments);
                var value = getTime.call(this);
                if (value !== value) return 'Invalid Date';
                var list = readLocales(locales);
                var read = readDateOptions(options);
                if (!time && read.timeStyle !== undefined) throw new TypeError('Invalid timeStyle option');
                if (!date && read.dateStyle !== undefined) throw new TypeError('Invalid dateStyle option');
                var styled = read.dateStyle !== undefined || read.timeStyle !== undefined;
                if (!styled && !(date && has(read, DATE_FIELDS)) && !(time && has(read, TIME_FIELDS))) {
                    (date ? ['year', 'month', 'day'] : []).concat(time ? TIME_FIELDS : []).forEach(function (name) { read[name] = 'numeric'; });
                }
                return askDates(bridge, JSON.stringify({ locales: list, options: read }), 'format', value);
            };
            Object.defineProperty(toLocale, 'name', { value: entry[0] });
            Object.defineProperty(Date.prototype, entry[0], { value: toLocale, writable: true, configurable: true, enumerable: false });
        });

        // A formatter's state sits in one non-enumerable slot, as Hermes's internal slots do not show.
        var DateTimeFormat = function DateTimeFormat(locales, options) {
            mark('Intl.DateTimeFormat');
            var self = this instanceof DateTimeFormat ? this : Object.create(DateTimeFormat.prototype);
            var state = {};
            Object.defineProperty(self, '_state', { value: state });
            var bridge = dateBridge();
            if (!bridge) {
                state.options = options || {};
                state.locale = (Array.isArray(locales) ? locales[0] : locales) || 'en';
                return self;
            }
            var list = readLocales(locales);
            var read = readDateOptions(options);
            // ECMA-402 2023 11.1.2 step 42, Hermes's checkOptions: a style with an explicit field is a TypeError.
            if ((read.dateStyle !== undefined || read.timeStyle !== undefined)
                && has(read, ['weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName'])) {
                throw new TypeError("{data/time}Style and explicit format components shouldn't be used together");
            }
            state.bridge = bridge;
            state.spec = JSON.stringify({ locales: list, options: read });
            // Hermes builds its formatter here, so a bad option throws now.
            state.resolved = JSON.parse(askDates(bridge, state.spec, 'resolvedOptions', 0));
            return self;
        };
        DateTimeFormat.prototype.resolvedOptions = function () {
            var state = this._state;
            if (!state.spec) return { locale: state.locale, timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn' };
            var copy = {};
            for (var name in state.resolved) copy[name] = state.resolved[name];
            return copy;
        };
        // Hermes's format is a getter that keeps one function bound to its formatter.
        Object.defineProperty(DateTimeFormat.prototype, 'format', {
            configurable: true,
            enumerable: false,
            get: function () {
                var dtf = this;
                var state = dtf._state;
                if (!state.format) {
                    state.format = function (date) {
                        if (state.spec) return askDates(state.bridge, state.spec, 'format', timeValue(date));
                        return dtf.formatToParts(date).map(function (part) { return part.value; }).join(' ');
                    };
                }
                return state.format;
            },
        });
        DateTimeFormat.prototype.formatToParts = function (date) {
            var state = this._state;
            if (state.spec) return JSON.parse(askDates(state.bridge, state.spec, 'formatToParts', timeValue(date)));
            var value = date instanceof Date ? date : new Date(date);
            var parts = [];
            var options = state.options;
            if (options.weekday) {
                var weekday = WEEKDAY_LONG[value.getDay()];
                parts.push({ type: 'weekday', value: options.weekday === 'long' ? weekday : weekday.slice(0, options.weekday === 'narrow' ? 1 : 3) });
            }
            if (options.month) {
                var month = MONTH_LONG[value.getMonth()];
                parts.push({ type: 'month', value: options.month === 'long' ? month
                    : options.month === 'numeric' ? String(value.getMonth() + 1)
                    : options.month === '2-digit' ? pad2(value.getMonth() + 1) : month.slice(0, 3) });
            }
            if (options.day) parts.push({ type: 'day', value: options.day === '2-digit' ? pad2(value.getDate()) : String(value.getDate()) });
            if (options.year) parts.push({ type: 'year', value: String(value.getFullYear()) });
            if (options.hour) parts.push({ type: 'hour', value: pad2(value.getHours()) });
            if (options.minute) parts.push({ type: 'minute', value: pad2(value.getMinutes()) });
            if (options.second) parts.push({ type: 'second', value: pad2(value.getSeconds()) });
            if (parts.length === 0) parts.push({ type: 'literal', value: value.toISOString() });
            return parts;
        };

        var NumberFormat = function NumberFormat(_locales, options) {
            mark('Intl.NumberFormat');
            this._min = (options && options.minimumFractionDigits) || 0;
            this._max = options && options.maximumFractionDigits != null ? options.maximumFractionDigits : Math.max(3, this._min);
        };
        NumberFormat.prototype.format = function (value) {
            var text = Number(value).toFixed(this._max);
            if (this._max > this._min) text = text.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
            return text;
        };
        NumberFormat.prototype.resolvedOptions = function () { return { locale: 'en' }; };

        var Locale = function Locale(tag) {
            mark('Intl.Locale');
            var text = String(tag || 'en');
            var pieces = text.split('-');
            this.baseName = text;
            this.language = pieces[0];
            this.region = pieces.length > 1 ? pieces[pieces.length - 1] : undefined;
            this.calendar = undefined;
        };
        Locale.prototype.toString = function () { return this.baseName; };
        Locale.prototype.maximize = function () { return this; };

        global.Intl = {
            Collator: Collator,
            DateTimeFormat: DateTimeFormat,
            NumberFormat: NumberFormat,
            Locale: Locale,
            RelativeTimeFormat: function () {
                mark('Intl.RelativeTimeFormat');
                this.format = function (value, unit) { return value + ' ' + unit; };
            },
            getCanonicalLocales: function (tags) { return Array.isArray(tags) ? tags.slice() : [tags]; },
        };
    }

    // --- queueMicrotask -----------------------------------------------------
    if (typeof global.queueMicrotask !== 'function') {
        global.queueMicrotask = function (fn) { Promise.resolve().then(fn); };
    }

    // --- console ------------------------------------------------------------
    if (typeof global.console !== 'object' || !global.console) {
        global.console = {};
    }
    var describe = function (value) {
        if (value instanceof Error) return value.name + ': ' + value.message + '\n' + (value.stack || '');
        if (value && typeof value === 'object') {
            try {
                return JSON.stringify(value, function (_key, inner) {
                    return inner instanceof Error ? inner.name + ': ' + inner.message : inner;
                });
            } catch (error) {
                return String(value);
            }
        }
        return String(value);
    };
    ['log', 'warn', 'error', 'info', 'debug'].forEach(function (level) {
        // QuickJS's built-in methods throw when no platform stdout is set.
        global.console[level] = function () {
            var parts = [];
            for (var i = 0; i < arguments.length; i += 1) parts.push(describe(arguments[i]));
            try { global.__hostLog(level + ': ' + parts.join(' ')); } catch (_error) { /* logging cannot fail a save */ }
        };
    });
    if (tracer) { tracer.trace(''); tracer.trace('js:bundleInit'); }
}(globalThis));
