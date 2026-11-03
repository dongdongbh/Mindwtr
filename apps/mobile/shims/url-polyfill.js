


let logWarn = () => {};
try {
    ({ logWarn } = require('../lib/app-log'));
} catch {

}


const decodeQueryComponent = (text) => decodeURIComponent(text.replace(/\+/g, ' '));

class FallbackURLSearchParams {
    constructor(init = '') {
        this._map = new Map();
        if (typeof init === 'string') {
            const stripped = init.startsWith('?') ? init.slice(1) : init;
            stripped.split('&').forEach(pair => {
                if (!pair) return;

                const at = pair.indexOf('=');
                const k = at < 0 ? pair : pair.slice(0, at);
                const v = at < 0 ? '' : pair.slice(at + 1);
                this.append(decodeQueryComponent(k), decodeQueryComponent(v));
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


const resolveHref = (input, base) => {
    const value = String(input || '');
    if (!base || /^[a-z][a-z0-9.+-]*:/i.test(value)) return value;
    const baseHref = String(base);
    const match = baseHref.match(/^([a-z][a-z0-9.+-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?/i);
    if (!match) throw new TypeError('Invalid base URL');
    const [, protocol, authority = '', basePath, baseSearch = ''] = match;
    if (value.startsWith('//')) return protocol + value;
    const prefix = protocol + authority;
    if (!value || value.startsWith('#')) return prefix + basePath + baseSearch + value;
    if (value.startsWith('?')) return prefix + basePath + value;
    const suffixAt = value.search(/[?#]/);
    const path = suffixAt < 0 ? value : value.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? '' : value.slice(suffixAt);
    const joined = path.startsWith('/') ? path
        : (basePath.slice(0, basePath.lastIndexOf('/') + 1) || (authority ? '/' : '')) + path;
    const segments = [];
    const parts = joined.split('/');
    for (const [index, part] of parts.entries()) {
        const dot = part.replace(/%2e/ig, '.');
        if (dot === '.' || dot === '..') {
            if (dot === '..' && segments.length > 1) segments.pop();
            if (index === parts.length - 1) segments.push('');
        } else segments.push(part);
    }
    return prefix + segments.join('/') + suffix;
};

class FallbackURL {


    constructor(url, base) {
        const href = resolveHref(url, base);
        this.href = href;
        const match = href.match(/^(?:([a-z0-9.+-]+:))?(?:\/\/([^\/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?/i);
        this.protocol = match ? (match[1] || '') : '';


        const authority = match && match[2] ? match[2] : '';
        const hostIndex = authority.lastIndexOf('@');
        this.host = hostIndex >= 0 ? authority.slice(hostIndex + 1) : authority;
        const portMatch = this.host.match(/:(\d*)$/);
        this.port = portMatch ? portMatch[1] : '';
        this.hostname = portMatch ? this.host.slice(0, -portMatch[0].length) : this.host;
        this.origin = /^(?:https?|wss?):$/i.test(this.protocol) && this.host
            ? `${this.protocol}//${this.host}`
            : 'null';
        this.pathname = match ? (match[3] || '/') : '/';
        this.search = match && match[4] ? '?' + match[4] : '';
        this.hash = match && match[5] ? '#' + match[5] : '';
        this.searchParams = new FallbackURLSearchParams(this.search);
    }
    toString() {
        return this.href;
    }


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


const NativeURL = typeof globalThis !== 'undefined' ? globalThis.URL : undefined;
const NativeURLSearchParams = typeof globalThis !== 'undefined' ? globalThis.URLSearchParams : undefined;


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

const URLSearchParamsPoly = nativeURLSearchParamsWorks ? NativeURLSearchParams : FallbackURLSearchParams;


if (!URLPoly.createObjectURL) {
    URLPoly.createObjectURL = FallbackURL.createObjectURL;
}
if (!URLPoly.revokeObjectURL) {
    URLPoly.revokeObjectURL = FallbackURL.revokeObjectURL;
}


if (typeof globalThis !== 'undefined') {
    globalThis.URL = URLPoly;
    globalThis.URLSearchParams = URLSearchParamsPoly;
}
if (typeof global !== 'undefined') {
    global.URL = URLPoly;
    global.URLSearchParams = URLSearchParamsPoly;
}

function setupURLPolyfill() {

    if (typeof globalThis !== 'undefined') {
        globalThis.URL = URLPoly;
        globalThis.URLSearchParams = URLSearchParamsPoly;
    }
    if (typeof global !== 'undefined') {
        global.URL = URLPoly;
        global.URLSearchParams = URLSearchParamsPoly;
    }

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
