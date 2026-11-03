

(() => {
    try {
        require('react-native/Libraries/Core/setUpTimers');
    } catch {

    }

    const root =
        typeof globalThis !== 'undefined'
            ? globalThis
            : typeof global !== 'undefined'
                ? global
                : typeof self !== 'undefined'
                    ? self
                    : typeof window !== 'undefined'
                        ? window
                        : null;

    if (!root) return;

    const schedule = (handler, args) => {
        if (typeof root.setTimeout === 'function') {
            return root.setTimeout(() => handler(...args), 0);
        }
        if (typeof root.queueMicrotask === 'function') {
            root.queueMicrotask(() => handler(...args));
            return 0;
        }
        if (typeof root.requestAnimationFrame === 'function') {
            return root.requestAnimationFrame(() => handler(...args));
        }
        handler(...args);
        return 0;
    };

    if (typeof root.setImmediate !== 'function') {
        root.setImmediate = (handler, ...args) => {
            if (typeof handler !== 'function') return schedule(() => {}, []);
            return schedule(handler, args);
        };
    }

    if (typeof root.clearImmediate !== 'function') {
        root.clearImmediate = (id) => {
            if (typeof root.clearTimeout === 'function') {
                root.clearTimeout(id);
                return;
            }
            if (typeof root.cancelAnimationFrame === 'function') {
                root.cancelAnimationFrame(id);
            }
        };
    }
})();

module.exports = {};
