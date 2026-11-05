import { beforeAll, describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { en } from '../../../packages/core/src/i18n/locales/en';

type Host = {
    language(stored: string, system: string): string;
    strings(keysJson: string): string;
    poll(ticket: string): string | null;
};
type StringsReply = { ok: boolean; value?: { language: string; strings: Record<string, string>; missing: string[] } };

let source = '';
beforeAll(async () => {
    const built = await build({ entryPoints: [new URL('../../android-native/bundle/host-entry.ts', import.meta.url).pathname],
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
}, 60_000);

const fixture = () => {
    const state: { MindwtrHost?: Host; [name: string]: unknown } = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: new Proxy({}, { get: (_target, property) => property === 'trace' || property === 'log' ? () => undefined : () => {
            throw new Error('Label catalogue must not call native storage: ' + String(property));
        } }),
    };
    vm.runInNewContext(source, state);
    const host = state.MindwtrHost;
    if (!host) throw new Error('Host did not initialize');
    const poll = async <T>(ticket: string): Promise<T> => {
        for (let step = 0; step < 100; step++) {
            const answer = host.poll(ticket);
            if (answer !== null) return JSON.parse(answer) as T;
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Strings read did not settle');
    };
    return { host, poll };
};

const readCatalogue = async (language: string) => {
    const { host, poll } = fixture();
    await poll(host.language(language, 'en-US'));
    const keys = Object.keys(en);
    const strings: Record<string, string> = {};
    const missing: string[] = [];
    for (let start = 0; start < keys.length; start += 500) {
        const reply = await poll<StringsReply>(host.strings(JSON.stringify(keys.slice(start, start + 500))));
        expect(reply.ok).toBe(true);
        Object.assign(strings, reply.value?.strings);
        missing.push(...reply.value?.missing ?? []);
    }
    return { keys, strings, missing, host, poll };
};

describe('native iOS label catalogue read', () => {
    it('returns a non-empty value for every English key in batches the strings call accepts', async () => {
        const { keys, strings, missing } = await readCatalogue('de');
        expect(missing).toEqual([]);
        expect(Object.keys(strings).sort()).toEqual([...keys].sort());
        expect(keys.filter((key) => !strings[key])).toEqual([]);
        expect(strings['common.cancel']).toBe('Abbrechen');
    });

    it('keeps the 500-key limit that makes the iOS read batch', async () => {
        const { keys, host, poll } = await readCatalogue('en');
        expect(keys.length).toBeGreaterThan(500);
        expect((await poll<StringsReply>(host.strings(JSON.stringify(keys.slice(0, 501))))).ok).toBe(false);
    });
});
