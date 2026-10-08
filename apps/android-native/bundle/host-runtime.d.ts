// esbuild resolves static locale requires. The shared core also probes these
// environment fields behind typeof guards; the native host has no Node API.
declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
