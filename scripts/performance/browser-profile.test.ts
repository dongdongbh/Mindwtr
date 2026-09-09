import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileBrowserWork } from './browser-profile.mjs';

it('does not connect a profiler during ordinary timing runs', async () => {
  const context = { newCDPSession: () => { throw new Error('Unexpected profiling'); } };
  expect(await profileBrowserWork(context, {}, null, async () => 42)).toBe(42);
});

for (const fails of [false, true]) {
  it(`retains the CPU profile and detaches after ${fails ? 'failed' : 'successful'} work`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindwtr-cpu-profile-'));
    const output = join(directory, 'settings.cpuprofile');
    const calls: string[] = [];
    const profile = { nodes: [], samples: [1], timeDeltas: [1000], startTime: 0, endTime: 1000 };
    const session = {
      send: async (method: string, params?: unknown) => {
        calls.push(method);
        if (method === 'Profiler.setSamplingInterval') expect(params).toEqual({ interval: 1000 });
        return { profile };
      },
      detach: async () => { calls.push('detach'); },
    };
    try {
      const promise = profileBrowserWork({ newCDPSession: async () => session }, {}, output, async () => {
        calls.push('work');
        if (fails) throw new Error('UI failed');
        return 42;
      });
      if (fails) await expect(promise).rejects.toThrow('UI failed');
      else expect(await promise).toBe(42);
      expect(calls).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'work', 'Profiler.stop', 'detach']);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(profile);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

it('detaches when profiler setup fails without running unprofiled work', async () => {
  let detached = false;
  const session = { send: async () => { throw new Error('CDP failed'); }, detach: async () => { detached = true; } };
  await expect(profileBrowserWork({ newCDPSession: async () => session }, {}, 'unused', async () => {
    throw new Error('Work must not run');
  })).rejects.toThrow('CDP failed');
  expect(detached).toBe(true);
});

it('does not hide a UI failure behind a profiler cleanup failure', async () => {
  const session = {
    send: async (method: string) => { if (method === 'Profiler.stop') throw new Error('Stop failed'); },
    detach: async () => { throw new Error('Detach failed'); },
  };
  await expect(profileBrowserWork({ newCDPSession: async () => session }, {}, 'unused', async () => {
    throw new Error('UI failed');
  })).rejects.toThrow('UI failed');
});
