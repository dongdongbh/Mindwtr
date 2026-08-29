declare module 'bun:test' {
  type TestCallback = () => unknown | Promise<unknown>;
  type Matchable = string | number | boolean | bigint | symbol | null | undefined | object;

  interface Matchers<T = unknown> {
    not: Matchers<T>;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<unknown>;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toThrow(expected?: string | RegExp | Error | (new (...args: any[]) => Error)): void;
    toHaveBeenCalledWith(...args: unknown[]): void;
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
  export const test: (name: string, callback: TestCallback, timeoutMs?: number) => void;
  export const beforeAll: (callback: TestCallback) => void;
  export const afterAll: (callback: TestCallback) => void;
  export const afterEach: (callback: TestCallback) => void;
  export const expect: Expect;
  export const spyOn: (object: object, method: string) => Spy;
}
