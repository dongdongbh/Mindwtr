import { afterEach, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import * as matchers from 'vitest-axe/matchers';
import 'vitest-axe/extend-expect';
expect.extend(matchers);

afterEach(() => {
    cleanup();
});

if (typeof window.requestAnimationFrame !== 'function') {
    Object.defineProperty(window, 'requestAnimationFrame', {
        writable: true,
        value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    });
}

if (typeof window.cancelAnimationFrame !== 'function') {
    Object.defineProperty(window, 'cancelAnimationFrame', {
        writable: true,
        value: (id: number) => window.clearTimeout(id),
    });
}


if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: vi.fn(),
    });
}


if (typeof File.prototype.arrayBuffer !== 'function') {
    File.prototype.arrayBuffer = function (this: File) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(this);
        });
    };
}

const localStorageMock = (function () {
    let store: Record<string, string> = {};
    return {
        getItem: function (key: string) {
            return store[key] || null;
        },
        setItem: function (key: string, value: string) {
            store[key] = value.toString();
        },
        clear: function () {
            store = {};
        },
        removeItem: function (key: string) {
            delete store[key];
        },
    };
})();

Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
});
