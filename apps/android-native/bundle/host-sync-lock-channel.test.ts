import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// File Sync's lock channel over the real host-polyfills.js (S5 review P2-1). A host cancel (another operation passed its
// deadline: CoreHost.callAsync, host-entry cancel, __cancelHostCalls) must never strand a lease: a release always reaches
// the lock, and an acquire that the cancel abandoned but the lock still granted is released when its late answer lands.
// RN's Expo lock calls are never cancelled from JS (rn-fix-inventory.md line 144).
const load = () => {
    const sent: Record<string, unknown>[] = [];
    const answers: string[] = [];
    let next = 0;
    const state: Record<string, unknown> = {
        __hostLog: () => {},
        __mindwtrNative: {
            syncLockCall: (json: string) => { sent.push(JSON.parse(json)); return `lock-${++next}`; },
            fileAbort: () => {},
            nowMs: () => Date.now(),
            ioNext: () => answers.shift() ?? '',
            ioBody: () => '',
        },
    };
    vm.runInNewContext(readFileSync(import.meta.dir + '/host-polyfills.js', 'utf8'), state);
    let lateReleases = 0;
    state.__mindwtrLockReleasedLate = () => { lateReleases += 1; };
    const lock = state.__mindwtrSyncLockCall as (request: Record<string, unknown>) => Promise<unknown>;
    const answer = (id: string, value: unknown) => { answers.push(JSON.stringify({ id, value })); (state.__pumpTimers as () => void)(); };
    const cancel = () => (state.__cancelHostCalls as (message: string) => void)('The host operation timed out');
    const resume = () => (state.__resumeHostCalls as () => void)();
    return { sent, lock, answer, cancel, resume, lateReleases: () => lateReleases };
};

describe('File Sync lock channel and host cancels', () => {
    it('sends a release while the host refuses other calls, and settles it with its answer', async () => {
        const host = load();
        host.cancel();
        const release = host.lock({ op: 'release', token: 't1' });
        expect(host.sent).toEqual([{ op: 'release', token: 't1' }]);
        host.answer('lock-1', null);
        await expect(release).resolves.toBeNull();
    });

    it('keeps a release that was already running when the host cancelled', async () => {
        const host = load();
        const release = host.lock({ op: 'release', token: 't1' });
        host.cancel();
        host.answer('lock-1', null);
        await expect(release).resolves.toBeNull();
    });

    it('releases the lease of an acquire the cancel abandoned once the lock grants it late', async () => {
        const host = load();
        const acquire = host.lock({ op: 'acquire', uri: 'content://p/tree/t' });
        host.cancel();
        await expect(acquire).rejects.toMatchObject({ name: 'AbortError' });
        host.answer('lock-1', 'late-token');
        expect(host.sent).toEqual([{ op: 'acquire', uri: 'content://p/tree/t' }, { op: 'release', token: 'late-token' }]);
        expect(host.lateReleases()).toBe(0);
        host.answer('lock-2', null);
        // host-sync.ts logs the release (v1.3.7/native-file-sync-late-release) once it answered.
        expect(host.lateReleases()).toBe(1);
        host.resume();
        // The lease is free again: the next acquire is sent and answered as usual.
        const again = host.lock({ op: 'acquire', uri: 'content://p/tree/t' });
        host.answer('lock-3', 'next-token');
        await expect(again).resolves.toBe('next-token');
    });

    it('releases nothing when the abandoned acquire was refused', async () => {
        const host = load();
        const acquire = host.lock({ op: 'acquire', uri: 'content://p/tree/t' });
        host.cancel();
        await expect(acquire).rejects.toMatchObject({ name: 'AbortError' });
        host.answer('lock-1', null);
        expect(host.sent).toEqual([{ op: 'acquire', uri: 'content://p/tree/t' }]);
        expect(host.lateReleases()).toBe(0);
    });

    it('still refuses a new acquire and revalidate while the host drains', async () => {
        const host = load();
        host.cancel();
        await expect(host.lock({ op: 'acquire', uri: 'content://p/tree/t' })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(host.lock({ op: 'revalidate', token: 't1' })).rejects.toMatchObject({ name: 'AbortError' });
        expect(host.sent).toEqual([]);
    });
});
