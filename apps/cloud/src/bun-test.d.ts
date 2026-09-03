declare module 'bun:test' {
    type TestCallback = () => unknown | Promise<unknown>;
    type Matchable = string | number | boolean | bigint | symbol | null | undefined | object;

    interface Matchers<T = unknown> {
        not: Matchers<T>;
        resolves: Matchers<Awaited<T>>;
        rejects: Matchers<unknown>;
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toMatch(expected: string | RegExp): void;
        toContain(expected: unknown): void;
        toHaveLength(expected: number): void;
        toBeGreaterThan(expected: number | bigint): void;
        toBeGreaterThanOrEqual(expected: number | bigint): void;
        toBeLessThanOrEqual(expected: number | bigint): void;
        toBeNull(): void;
        toBeTruthy(): void;
        toBeUndefined(): void;
        toThrow(expected?: string | RegExp | Error): void;
    }

    interface Expect {
        <T extends Matchable | Promise<unknown>>(actual: T): Matchers<T>;
        (actual: () => unknown): Matchers<unknown>;
    }

    interface Spy {
        mockImplementation(fn: (...args: unknown[]) => unknown): Spy;
        mockRestore(): void;
    }

    export const describe: (name: string, callback: TestCallback) => void;
    // bun's runtime accepts a per-test timeout as the third argument (the mcp-server
    // shim declares the same); two-process tests need more than the 5 s default.
    export const test: (name: string, callback: TestCallback, timeoutMs?: number) => void;
    export const beforeEach: (callback: TestCallback) => void;
    export const afterEach: (callback: TestCallback) => void;
    export const expect: Expect;
    export const spyOn: (object: object, method: string) => Spy;
}

type RequestDuplex = 'half';

interface RequestInit {
    duplex?: RequestDuplex;
}
