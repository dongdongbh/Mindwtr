import { expect } from 'vitest';
import '@testing-library/jest-dom';
import * as matchers from 'vitest-axe/matchers';
import 'vitest-axe/extend-expect'; // Keep for types if needed, but extend manually too just in case
expect.extend(matchers);

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
