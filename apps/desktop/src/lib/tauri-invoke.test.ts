import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

const invokeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    throw new Error('no ipc');
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
    invokeNative,
    invokeNativeOr,
    preloadNativeTransport,
    setNativeInvokeTransport,
} from './tauri-invoke';

const enableTauri = () => {
    (window as any).__TAURI_INTERNALS__ = {};
};

const disableTauri = () => {
    delete (window as any).__TAURI_INTERNALS__;
};

beforeEach(() => {
    invokeMock.mockClear();
});

afterEach(() => {
    setNativeInvokeTransport(null);
    disableTauri();
    delete (window as any).__mindwtrNativeInvokeTransport;
    vi.unstubAllEnvs();
});

describe('invokeNative', () => {
    it('rejects when there is no Tauri runtime', async () => {
        const transport = vi.fn();
        setNativeInvokeTransport(transport as never);
        await expect(invokeNative('get_thing')).rejects.toThrow('Tauri runtime is unavailable.');
        expect(transport).not.toHaveBeenCalled();
    });

    it('forwards the command and args to the transport', async () => {
        enableTauri();
        const transport = vi.fn(async () => 'ok');
        setNativeInvokeTransport(transport as never);
        await expect(invokeNative<string>('get_thing', { id: 7 })).resolves.toBe('ok');
        expect(transport).toHaveBeenCalledWith('get_thing', { id: 7 });
    });

    it('leaves an argument-less command argument-less on the wire', async () => {
        enableTauri();
        await expect(invokeNative('get_thing')).rejects.toThrow();
        expect(invokeMock.mock.calls[0]).toEqual(['get_thing']);
    });

    it('propagates transport failures', async () => {
        enableTauri();
        setNativeInvokeTransport((async () => {
            throw new Error('boom');
        }) as never);
        await expect(invokeNative('get_thing')).rejects.toThrow('boom');
    });
});

describe('invokeNativeOr', () => {
    it('resolves to the fallback when there is no Tauri runtime', async () => {
        const transport = vi.fn();
        setNativeInvokeTransport(transport as never);
        await expect(invokeNativeOr({ enabled: false }, 'get_thing')).resolves.toEqual({ enabled: false });
        expect(transport).not.toHaveBeenCalled();
    });

    it('returns the native result when the runtime is present', async () => {
        enableTauri();
        setNativeInvokeTransport((async () => ({ enabled: true })) as never);
        await expect(invokeNativeOr({ enabled: false }, 'get_thing')).resolves.toEqual({ enabled: true });
    });

    it('does not swallow transport failures inside the runtime', async () => {
        enableTauri();
        setNativeInvokeTransport((async () => {
            throw new Error('boom');
        }) as never);
        await expect(invokeNativeOr('fallback', 'get_thing')).rejects.toThrow('boom');
    });
});

describe('preloadNativeTransport', () => {
    // Callers preload for timing, not for a result, so it must stay a no-op off
    // Tauri — a rejection here would break the reveal path it exists to protect.
    it('resolves without reaching for the module off Tauri', async () => {
        await expect(preloadNativeTransport()).resolves.toBeUndefined();
    });
});

// Ten hand-rolled `tauriInvoke` copies existed before this seam, in three
// different off-Tauri shapes (throw / return a default / swallow), because
// nothing stopped the eleventh from being written. This is that stop.
const DESKTOP_SRC = resolve(import.meta.dirname, '..');
const CORE_MODULE_SPECIFIER = '@tauri-apps/api/core';
const SEAM_FILE = 'lib/tauri-invoke.ts';
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'coverage', 'dist']);
// Each entry needs a reason and a way out. Converting one of these? Delete its
// line — the stale-exclusion test below fails until you do, because a list that
// only ever grows quietly re-permits the thing the ratchet exists to prevent.
const EXCLUDED_FILES = new Map<string, string>([
    // convertFileSrc rewrites a path into a webview URL. It is not an IPC call,
    // so the invoke seam has nothing to offer it.
    ['components/Task/task-item-attachment-utils.ts', 'imports convertFileSrc, not invoke'],
]);

function collectSourcePaths(): string[] {
    const paths: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.tsx?$/.test(entry.name)) continue;
            // Tests mock the module by specifier; that is the point of a seam,
            // not a bypass of it.
            if (/\.test\.tsx?$/.test(entry.name)) continue;
            paths.push(full);
        }
    };
    walk(DESKTOP_SRC);
    return paths;
}

// Walking every desktop source file runs well under a second locally and has
// still blown vitest's 5s default on loaded CI runners, so both tests below
// share one walk.
let coreImporters: Set<string> | null = null;
const filesImportingCore = (): Set<string> => (coreImporters ??= new Set(
    collectSourcePaths()
        .filter((path) => readFileSync(path, 'utf8').includes(CORE_MODULE_SPECIFIER))
        .map((path) => relative(DESKTOP_SRC, path)),
));

describe('tauri invoke seam ratchet', () => {
    it('keeps @tauri-apps/api/core out of every desktop source file but the seam', () => {
        const offenders = [...filesImportingCore()]
            .filter((rel) => rel !== SEAM_FILE && !EXCLUDED_FILES.has(rel));

        expect(
            offenders,
            `${offenders.join(', ')} imports ${CORE_MODULE_SPECIFIER} directly. Call invokeNative`
            + ' (rejects off Tauri) or invokeNativeOr(fallback, ...) (resolves to the fallback) from'
            + ` src/${SEAM_FILE} instead — whichever matches what the call site should do when there`
            + ' is no desktop runtime. Adding an exclusion here re-splits that decision across files.',
        ).toEqual([]);
    }, 60_000);

    it('carries no exclusion for a file that has already dropped the raw import', () => {
        const importers = filesImportingCore();
        const stale = [...EXCLUDED_FILES.keys()].filter((rel) => !importers.has(rel));

        expect(
            stale,
            `${stale.join(', ')} no longer imports ${CORE_MODULE_SPECIFIER}, so its EXCLUDED_FILES`
            + ' entry is stale. Delete the entry — left in place it silently re-permits a raw import'
            + ' in a file the ratchet would otherwise catch.',
        ).toEqual([]);
    }, 60_000);
});

describe('setNativeInvokeTransport', () => {
    it('restores the real transport when passed null', async () => {
        enableTauri();
        setNativeInvokeTransport((async () => 'fake') as never);
        await expect(invokeNative<string>('get_thing')).resolves.toBe('fake');
        setNativeInvokeTransport(null);
        // The real transport reaches @tauri-apps/api/core, which has no IPC
        // handler in jsdom; the point is only that the fake is gone.
        await expect(invokeNative<string>('get_thing')).rejects.toThrow();
    });
});

describe('native invoke profiling transport', () => {
    it('keeps the normal transport direct and does not expose a profiling hook', async () => {
        vi.stubEnv('VITE_STARTUP_PROFILING', '0');
        enableTauri();
        invokeMock.mockResolvedValueOnce('normal');

        await expect(invokeNative('get_thing')).resolves.toBe('normal');

        expect(invokeMock).toHaveBeenCalledWith('get_thing');
        expect((window as any).__mindwtrNativeInvokeTransport).toBeUndefined();
    });

    it('does not silently replace a profiling transport owned elsewhere', async () => {
        vi.stubEnv('VITE_STARTUP_PROFILING', '1');
        enableTauri();
        (window as any).__mindwtrNativeInvokeTransport = { invoke: vi.fn() };

        await expect(invokeNative('get_thing')).rejects.toThrow('profiling transport already exists');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('routes profiling calls through a writable hook without touching immutable Tauri internals', async () => {
        vi.stubEnv('VITE_STARTUP_PROFILING', '1');
        const immutableInvoke = vi.fn();
        const internals = {} as Record<string, unknown>;
        Object.defineProperty(internals, 'invoke', {
            value: immutableInvoke,
            writable: false,
            configurable: false,
        });
        (window as any).__TAURI_INTERNALS__ = internals;
        const descriptor = Object.getOwnPropertyDescriptor(internals, 'invoke');
        invokeMock.mockResolvedValueOnce('original');

        await expect(invokeNative('save_data', { revision: 7 })).resolves.toBe('original');
        const profilingTransport = (window as any).__mindwtrNativeInvokeTransport;
        expect(profilingTransport).toMatchObject({
            schemaVersion: 1,
            label: 'mindwtr-native-invoke-transport-v1',
            invoke: invokeMock,
        });
        expect(Object.getOwnPropertyDescriptor(internals, 'invoke')).toEqual(descriptor);

        const wrapped = vi.fn(async () => 'wrapped');
        profilingTransport.invoke = wrapped;
        await expect(invokeNative('save_task')).resolves.toBe('wrapped');
        expect(wrapped.mock.calls[0]).toEqual(['save_task']);
        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(immutableInvoke).not.toHaveBeenCalled();
    });
});
