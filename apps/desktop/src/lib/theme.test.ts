import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemeMode, watchNativeSystemThemePreference, watchSystemThemePreference } from './theme';

const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

const createDeferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
};

describe('applyThemeMode', () => {
    beforeEach(() => {
        document.documentElement.className = '';
    });

    afterEach(() => {
        document.documentElement.className = '';
    });

    it('applies dark mode when system theme resolves to dark', () => {
        applyThemeMode('system', 'dark');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('removes dark mode when system theme resolves to light', () => {
        document.documentElement.classList.add('dark');

        applyThemeMode('system', 'light');

        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
});

describe('watchSystemThemePreference', () => {
    const originalMatchMedia = window.matchMedia;

    afterEach(() => {
        window.matchMedia = originalMatchMedia;
        vi.restoreAllMocks();
    });

    it('forwards prefers-color-scheme changes and unsubscribes cleanly', () => {
        const listeners = new Set<(event: { matches: boolean }) => void>();
        const addEventListener = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.add(listener as unknown as (event: { matches: boolean }) => void);
        });
        const removeEventListener = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.delete(listener as unknown as (event: { matches: boolean }) => void);
        });

        window.matchMedia = vi.fn().mockImplementation(() => ({
            matches: false,
            media: '(prefers-color-scheme: dark)',
            onchange: null,
            addEventListener,
            removeEventListener,
            addListener: undefined,
            removeListener: undefined,
            dispatchEvent: vi.fn(),
        })) as typeof window.matchMedia;

        const onChange = vi.fn();
        const stopWatching = watchSystemThemePreference(onChange);

        expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
        const [listener] = Array.from(listeners);
        expect(listener).toBeTypeOf('function');

        listener({ matches: true });
        listener({ matches: false });

        expect(onChange).toHaveBeenNthCalledWith(1, 'dark');
        expect(onChange).toHaveBeenNthCalledWith(2, 'light');

        stopWatching();

        expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
        expect(listeners.size).toBe(0);
    });
});

describe('watchNativeSystemThemePreference', () => {
    it('does not touch the native window api after cleanup when the module resolves late', async () => {
        const windowModuleDeferred = createDeferred<{
            getCurrentWindow: () => {
                theme: ReturnType<typeof vi.fn>;
                onThemeChanged: ReturnType<typeof vi.fn>;
            };
        }>();
        const theme = vi.fn(async () => 'dark');
        const onThemeChanged = vi.fn(async () => vi.fn());
        const onChange = vi.fn();

        const stopWatching = watchNativeSystemThemePreference(
            () => windowModuleDeferred.promise,
            onChange,
        );
        stopWatching();
        windowModuleDeferred.resolve({
            getCurrentWindow: () => ({
                theme,
                onThemeChanged,
            }),
        });
        await flushMicrotasks();

        expect(theme).not.toHaveBeenCalled();
        expect(onThemeChanged).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('unsubscribes a late native theme listener after cleanup', async () => {
        const unlisten = vi.fn();
        const onThemeChangedDeferred = createDeferred<() => void>();
        const onChange = vi.fn();

        const stopWatching = watchNativeSystemThemePreference(
            async () => ({
                getCurrentWindow: () => ({
                    theme: async () => 'dark',
                    onThemeChanged: vi.fn(async () => onThemeChangedDeferred.promise),
                }),
            }),
            onChange,
        );
        await flushMicrotasks();
        stopWatching();
        onThemeChangedDeferred.resolve(unlisten);
        await flushMicrotasks();

        expect(onChange).toHaveBeenCalledWith('dark');
        expect(unlisten).toHaveBeenCalledTimes(1);
    });
});
