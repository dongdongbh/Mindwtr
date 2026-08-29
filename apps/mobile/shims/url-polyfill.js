// Lightweight shim that prefers native Hermes URL/URLSearchParams.
// Falls back to a minimal, standards-like implementation if missing.
// IMPORTANT: This file is loaded via Metro's getModulesRunBeforeMainModule
// to ensure it runs before any other module that might need URL.

let logWarn = () => {};
try {
    ({ logWarn } = require('../lib/app-log'));
} catch {
    // No-op in test environments where TS modules aren't resolved.
}

class FallbackURLSearchParams {
    constructor(init = '') {
        this._map = new Map();
        if (typeof init === 'string') {
            const stripped = init.startsWith('?') ? init.slice(1) : init;
            stripped.split('&').forEach(pair => {
                if (!pair) return;
                const [k, v = ''] = pair.split('=');
                this.append(decodeURIComponent(k), decodeURIComponent(v));
            });
        } else if (init && typeof init === 'object' && Symbol.iterator in init) {
            for (const [k, v] of init) this.append(k, v);
        } else if (init && typeof init === 'object') {
            Object.entries(init).forEach(([k, v]) => this.set(k, v));
        }
    }
    _ensure(key) {
        if (!this._map.has(key)) this._map.set(key, []);
    }
    append(key, value) {
        this._ensure(key);
        this._map.get(key).push(String(value));
    }
    set(key, value) {
        this._map.set(key, [String(value)]);
    }
    get(key) {
        const vals = this._map.get(key);
        return vals && vals.length ? vals[0] : null;
    }
    getAll(key) {
        return this._map.get(key) ? [...this._map.get(key)] : [];
    }
    has(key) {
        return this._map.has(key);
    }
    delete(key) {
        this._map.delete(key);
    }
    toString() {
        const parts = [];
        this._map.forEach((vals, key) => {
            vals.forEach(val => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`));
        });
        return parts.join('&');
    }
    forEach(cb, thisArg) {
        this._map.forEach((vals, key) => vals.forEach(val => cb.call(thisArg, val, key, this)));
    }
    entries() {
        const arr = [];
        this.forEach((val, key) => arr.push([key, val]));
        return arr[Symbol.iterator]();
    }
    keys() {
        return this._map.keys();
    }
    values() {
        const vals = [];
        this.forEach(val => vals.push(val));
        return vals[Symbol.iterator]();
    }
    [Symbol.iterator]() {
        return this.entries();
    }
}

class FallbackURL {
    constructor(url, base) {
        const href = base ? new FallbackURL(base).href + String(url || '') : String(url || '');
        this.href = href;
        const match = href.match(/^(?:([a-z0-9.+-]+:))?(?:\/\/[^\/?#]*)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?/i);
        this.protocol = match ? (match[1] || '') : '';
        this.pathname = match ? (match[2] || '/') : '/';
        this.search = match && match[3] ? '?' + match[3] : '';
        this.hash = match && match[4] ? '#' + match[4] : '';
        this.searchParams = new FallbackURLSearchParams(this.search);
    }
    toString() {
        return this.href;
    }
    /**
     * Non-standard implementation: returns empty string instead of throwing or creating a blob URL.
     * 
     * Rationale: React Native (especially Hermes) does not support Blob/File API fully in the same way
     * browsers do. Many libraries call this feature detection or blindly.
     * Throwing here causes immediate crashes in those libraries.
     * returning '' is safer and prevents the crash, though function will assume it failed or got nothing.
     */
    static createObjectURL() {
        void logWarn('[Mindwtr] URL.createObjectURL called but not supported by shim. Returning empty string to prevent crash.', {
            scope: 'polyfill',
        });
        return '';
    }
    static revokeObjectURL() { }
    static canParse(url, base) {
        try {
            // eslint-disable-next-line no-new
            new FallbackURL(url, base);
            return true;
        } catch {
            return false;
        }
    }
}

// Determine which implementation to use
const NativeURL = typeof globalThis !== 'undefined' ? globalThis.URL : undefined;
const NativeURLSearchParams = typeof globalThis !== 'undefined' ? globalThis.URLSearchParams : undefined;

// Check if native URLSearchParams has .keys() method (the critical missing feature)
const nativeURLSearchParamsWorks = (() => {
    try {
        if (NativeURLSearchParams) {
            const test = new NativeURLSearchParams('test=1');
            return typeof test.keys === 'function';
        }
        return false;
    } catch {
        return false;
    }
})();

const URLPoly = NativeURL || FallbackURL;
// Use fallback if native lacks .keys()
const URLSearchParamsPoly = nativeURLSearchParamsWorks ? NativeURLSearchParams : FallbackURLSearchParams;

// Patch createObjectURL/revokeObjectURL if missing (e.g. strict Hermes)
if (!URLPoly.createObjectURL) {
    URLPoly.createObjectURL = FallbackURL.createObjectURL;
}
if (!URLPoly.revokeObjectURL) {
    URLPoly.revokeObjectURL = FallbackURL.revokeObjectURL;
}

// Set globals at module load time (before exports)
// This ensures URL is defined before any other module tries to use it
if (typeof globalThis !== 'undefined') {
    globalThis.URL = URLPoly;
    globalThis.URLSearchParams = URLSearchParamsPoly;
}
if (typeof global !== 'undefined') {
    global.URL = URLPoly;
    global.URLSearchParams = URLSearchParamsPoly;
}

function setupURLPolyfill() {
    // Ensure globals are set in case tests or other shims reset them.
    if (typeof globalThis !== 'undefined') {
        globalThis.URL = URLPoly;
        globalThis.URLSearchParams = URLSearchParamsPoly;
    }
    if (typeof global !== 'undefined') {
        global.URL = URLPoly;
        global.URLSearchParams = URLSearchParamsPoly;
    }
    // Patch createObjectURL/revokeObjectURL if missing (e.g. strict Hermes)
    if (!URLPoly.createObjectURL) {
        URLPoly.createObjectURL = FallbackURL.createObjectURL;
    }
    if (!URLPoly.revokeObjectURL) {
        URLPoly.revokeObjectURL = FallbackURL.revokeObjectURL;
    }
}

module.exports = {
    URL: URLPoly,
    URLSearchParams: URLSearchParamsPoly,
    setupURLPolyfill,
    default: { URL: URLPoly, URLSearchParams: URLSearchParamsPoly },
};
