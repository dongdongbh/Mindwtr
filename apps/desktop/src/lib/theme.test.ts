import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applyNativeTheme,
    applyStartupSystemThemeBeforeApp,
    applySystemThemeChange,
    applyThemeMode,
    coerceDesktopThemeMode,
    coerceSystemThemePreference,
    resolveDesktopThemeMode,
    resolveNativeTheme,
    resolveSystemThemeCommandPreference,
    resolveSystemThemePreference,
    setSystemSchemeOverride,
    watchSystemThemePortalPreference,
    watchNativeSystemThemePreference,
    watchSystemThemePreference,
} from './theme';
import { setNativeInvokeTransport } from './tauri-invoke';

type NativeThemeWindowModule = Awaited<
    ReturnType<Parameters<typeof watchNativeSystemThemePreference>[0]>
>;
type NativeThemeWindow = ReturnType<NativeThemeWindowModule['getCurrentWindow']>;

// The theme commands go through the invoke seam, which refuses to reach Rust
// unless a Tauri runtime is present. Both are true in the desktop shell.
const enableNativeInvoke = (transport: (command: string) => Promise<unknown>) => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setNativeInvokeTransport(transport as never);
};

const disableNativeInvoke = () => {
    setNativeInvokeTransport(null);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
};

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

    // Tailwind is darkMode:'class', so a preset theme that forgets the `dark`
    // class paints light-mode utilities over dark CSS variables.
    it.each([
        ['nord', 'theme-nord'],
        ['catppuccin-macchiato', 'theme-catppuccin-macchiato'],
        ['dracula', 'theme-dracula'],
        ['oled', 'theme-oled'],
    ] as const)('marks %s as a dark theme and applies its class', (mode, className) => {
        applyThemeMode(mode, 'light');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.classList.contains(className)).toBe(true);
    });

    it('drops the previous theme class when switching between preset themes', () => {
        applyThemeMode('dracula', 'light');
        applyThemeMode('catppuccin-macchiato', 'light');

        expect(document.documentElement.classList.contains('theme-dracula')).toBe(false);
        expect(document.documentElement.classList.contains('theme-catppuccin-macchiato')).toBe(true);

        applyThemeMode('light', 'dark');

        expect(document.documentElement.classList.contains('theme-catppuccin-macchiato')).toBe(false);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('reuses the last native system preference when the webview reports stale light mode', () => {
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = vi.fn().mockReturnValue({ matches: false } as MediaQueryList);

        try {
            expect(resolveSystemThemePreference('dark')).toBe('dark');
            expect(resolveSystemThemePreference()).toBe('dark');
        } finally {
            window.matchMedia = originalMatchMedia;
        }
    });
});

describe('resolveDesktopThemeMode', () => {
    it('defaults missing synced and stored theme values to system', () => {
        expect(resolveDesktopThemeMode(undefined, null)).toBe('system');
    });

    it('keeps an older local-only theme preference when synced settings are missing', () => {
        expect(resolveDesktopThemeMode(undefined, 'dark')).toBe('dark');
    });

    it('prefers synced settings over older local storage', () => {
        expect(resolveDesktopThemeMode('system', 'dark')).toBe('system');
    });

    it('collapses unsupported material3 theme values to the scheme they render as', () => {
        expect(resolveDesktopThemeMode('material3-dark', null)).toBe('dark');
        expect(resolveDesktopThemeMode('material3-light', null)).toBe('light');
        expect(resolveDesktopThemeMode(undefined, 'material3-light')).toBe('light');
    });

    it('carries the new preset themes through sync and local storage untouched', () => {
        expect(resolveDesktopThemeMode('catppuccin-macchiato', null)).toBe('catppuccin-macchiato');
        expect(resolveDesktopThemeMode('dracula', null)).toBe('dracula');
        expect(resolveDesktopThemeMode('oled', null)).toBe('oled');
        expect(resolveDesktopThemeMode(undefined, 'catppuccin-macchiato')).toBe('catppuccin-macchiato');
        expect(resolveDesktopThemeMode(undefined, 'dracula')).toBe('dracula');
        expect(resolveDesktopThemeMode(undefined, 'oled')).toBe('oled');
    });
});

describe('coerceDesktopThemeMode', () => {
    it('accepts the preset themes and rejects an unknown value', () => {
        expect(coerceDesktopThemeMode('catppuccin-macchiato')).toBe('catppuccin-macchiato');
        expect(coerceDesktopThemeMode('dracula')).toBe('dracula');
        // A one-letter drift in either identifier must not silently resolve.
        expect(coerceDesktopThemeMode('catpuccin-macchiato')).toBeNull();
        expect(coerceDesktopThemeMode('draculaa')).toBeNull();
    });
});

describe('resolveNativeTheme', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reports the preset themes to the native window as dark', () => {
        expect(resolveNativeTheme('catppuccin-macchiato')).toBe('dark');
        expect(resolveNativeTheme('dracula')).toBe('dark');
        expect(resolveNativeTheme('sepia')).toBe('light');
    });

    it('uses the resolved system preference for Linux GTK titlebars', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
        expect(resolveNativeTheme('system', 'dark')).toBe('dark');
        expect(resolveNativeTheme('system-oled', 'light')).toBe('light');
        expect(resolveNativeTheme('system', 'light')).toBe('light');
    });

    it('leaves system theme native on other platforms', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
        expect(resolveNativeTheme('system', 'dark')).toBeNull();
        expect(resolveNativeTheme('system-oled', 'dark')).toBeNull();
    });
});

describe('applyNativeTheme', () => {
    it('applies the resolved theme to both the app and current window', async () => {
        const setAppTheme = vi.fn(async () => undefined);
        const setWindowTheme = vi.fn(async () => undefined);
        const theme = vi.fn(async () => 'dark' as const);
        const onThemeChanged = vi.fn(async () => vi.fn());

        const applied = await applyNativeTheme(
            'dark',
            async () => ({ setTheme: setAppTheme }),
            async () => ({ getCurrentWindow: () => ({ theme, onThemeChanged, setTheme: setWindowTheme }) }),
        );

        expect(setAppTheme).toHaveBeenCalledWith('dark');
        expect(setWindowTheme).toHaveBeenCalledWith('dark');
        expect(applied).toBe(true);
    });

    it('reports app and window theme errors independently', async () => {
        const appError = new Error('app theme failed');
        const windowError = new Error('window theme failed');
        const onError = vi.fn();

        const applied = await applyNativeTheme(
            'light',
            async () => ({ setTheme: vi.fn(async () => { throw appError; }) }),
            async () => ({
                getCurrentWindow: () => ({
                    theme: vi.fn(async () => 'light' as const),
                    onThemeChanged: vi.fn(async () => vi.fn()),
                    setTheme: vi.fn(async () => { throw windowError; }),
                }),
            }),
            onError,
        );

        expect(onError).toHaveBeenCalledWith('app', appError);
        expect(onError).toHaveBeenCalledWith('window', windowError);
        expect(applied).toBe(false);
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

    it('updates both webview and Linux titlebar on a media fallback transition without repeating setter events', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
        let listener: ((event: { matches: boolean }) => void) | undefined;
        window.matchMedia = vi.fn().mockImplementation(() => ({
            matches: false,
            addEventListener: (_event: string, callback: (event: { matches: boolean }) => void) => { listener = callback; },
            removeEventListener: vi.fn(),
        })) as typeof window.matchMedia;
        const setAppTheme = vi.fn(async () => undefined);
        const setWindowTheme = vi.fn(async () => undefined);
        const stop = watchSystemThemePreference((theme) => applySystemThemeChange('system', theme, (resolved) => {
            void applyNativeTheme(
                resolveNativeTheme('system', resolved),
                async () => ({ setTheme: setAppTheme }),
                async () => ({ getCurrentWindow: () => ({
                    theme: async () => resolved,
                    onThemeChanged: async () => () => { },
                    setTheme: setWindowTheme,
                }) }),
            );
        }));

        listener?.({ matches: true });
        listener?.({ matches: true }); // GTK setting the same color must not recurse.
        await flushMicrotasks();
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(setWindowTheme).toHaveBeenCalledTimes(1);
        expect(setWindowTheme).toHaveBeenCalledWith('dark');

        listener?.({ matches: false });
        await flushMicrotasks();
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(setAppTheme).toHaveBeenNthCalledWith(2, 'light');
        expect(setWindowTheme).toHaveBeenNthCalledWith(2, 'light');
        stop();
    });
});

describe('applyStartupSystemThemeBeforeApp', () => {
    it('discards a delayed System result after App takes ownership of theme', async () => {
        const deferred = createDeferred<'light' | 'dark' | null>();
        let appOwnsTheme = false;
        const apply = vi.fn();
        const pending = applyStartupSystemThemeBeforeApp(deferred.promise, () => appOwnsTheme, apply);
        appOwnsTheme = true;
        deferred.resolve('light');
        await pending;
        expect(apply).not.toHaveBeenCalled();

        await applyStartupSystemThemeBeforeApp(Promise.resolve('dark'), () => false, apply);
        expect(apply).toHaveBeenCalledExactlyOnceWith('dark');
    });
});

describe('coerceSystemThemePreference', () => {
    it('keeps only supported native theme values', () => {
        expect(coerceSystemThemePreference('dark')).toBe('dark');
        expect(coerceSystemThemePreference('light')).toBe('light');
        expect(coerceSystemThemePreference('system')).toBeNull();
        expect(coerceSystemThemePreference(null)).toBeNull();
    });
});

describe('resolveSystemThemeCommandPreference', () => {
    afterEach(disableNativeInvoke);

    it('reads the native command preference', async () => {
        const invoke = vi.fn(async () => 'dark');
        enableNativeInvoke(invoke);

        await expect(resolveSystemThemeCommandPreference()).resolves.toBe('dark');
        expect(invoke).toHaveBeenCalledWith('get_system_theme_preference', undefined);
    });

    it('reports command errors and falls back to no preference', async () => {
        const error = new Error('command failed');
        const onError = vi.fn();
        enableNativeInvoke(async () => {
            throw error;
        });

        await expect(resolveSystemThemeCommandPreference(onError)).resolves.toBeNull();
        expect(onError).toHaveBeenCalledWith('resolveSystem', error);
    });

    it('reports the absence of a desktop runtime and falls back to no preference', async () => {
        const onError = vi.fn();

        await expect(resolveSystemThemeCommandPreference(onError)).resolves.toBeNull();
        expect(onError).toHaveBeenCalledWith('resolveSystem', expect.any(Error));
    });
});

describe('watchSystemThemePortalPreference', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards portal changes without polling and stops listening on cleanup', async () => {
        let listener: ((event: { payload: unknown }) => void) | undefined;
        const unlisten = vi.fn();
        const listen = vi.fn(async (_event: string, callback: (event: { payload: unknown }) => void) => {
            listener = callback;
            return unlisten;
        });
        const onChange = vi.fn();
        const stopWatching = watchSystemThemePortalPreference(async () => ({ listen }), onChange);
        await flushMicrotasks();
        await flushMicrotasks();

        expect(listen).toHaveBeenCalledWith('system-theme-portal-changed', expect.any(Function));
        listener?.({ payload: 'dark' });
        expect(onChange).toHaveBeenCalledWith('dark');
        listener?.({ payload: 'invalid' });
        expect(onChange).toHaveBeenCalledTimes(1);
        stopWatching();
        expect(unlisten).toHaveBeenCalledOnce();
        listener?.({ payload: 'light' });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reports subscription failures', async () => {
        const error = new Error('subscription failed');
        const onError = vi.fn();
        const stopWatching = watchSystemThemePortalPreference(
            async () => ({ listen: async () => { throw error; } }),
            vi.fn(),
            onError,
        );
        await flushMicrotasks();
        await flushMicrotasks();
        expect(onError).toHaveBeenCalledWith('watch', error);
        stopWatching();
    });
});

describe('watchNativeSystemThemePreference', () => {
    beforeEach(() => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows'));
    afterEach(() => vi.restoreAllMocks());

    it('does not use GTK theme events as system preference on Linux', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
        const loadWindowModule = vi.fn();
        const onChange = vi.fn();
        watchNativeSystemThemePreference(loadWindowModule, onChange)();
        await flushMicrotasks();
        expect(loadWindowModule).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not touch the native window api after cleanup when the module resolves late', async () => {
        const windowModuleDeferred = createDeferred<NativeThemeWindowModule>();
        const theme = vi.fn<NativeThemeWindow['theme']>(async () => 'dark');
        const onThemeChanged = vi.fn<NativeThemeWindow['onThemeChanged']>(
            async () => vi.fn<() => void>(),
        );
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

describe('setSystemSchemeOverride', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        setSystemSchemeOverride(null);
        document.documentElement.className = '';
    });

    it('outranks a platform preference that arrives afterwards', () => {
        setSystemSchemeOverride('light');
        expect(resolveSystemThemePreference('dark')).toBe('light');
    });

    it('returns the decision to the platform once cleared', () => {
        setSystemSchemeOverride('light');
        setSystemSchemeOverride(null);
        expect(resolveSystemThemePreference('dark')).toBe('dark');
    });

    it('keeps the dark class off when the palette is light and the platform says dark', () => {
        setSystemSchemeOverride('light');
        applyThemeMode('system', 'dark');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('reports the palette scheme to the native window', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
        setSystemSchemeOverride('light');
        expect(resolveNativeTheme('system', 'dark')).toBe('light');
    });
});
