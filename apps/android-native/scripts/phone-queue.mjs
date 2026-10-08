// Shows who holds the S23 test phone and who waits for it: every flock on /home/dd/scratch/s23.lock (and on the per-check
// device lock of device-lock.mjs), with start time, the check running now and the log folder when the command line shows it.
//
//   node apps/android-native/scripts/phone-queue.mjs
//
// It reads /proc only (/proc/locks for who holds, /proc/<pid>/cmdline and stat for the rest), not `ps`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SERIAL } from './run-device-batch.mjs';

const locks = ['/home/dd/scratch/s23.lock', join(homedir(), '.mindwtr-harness', `device-${SERIAL}.lock`)];
const read = (path) => {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
};

const bootTime = Number(/^btime (\d+)/m.exec(read('/proc/stat'))?.[1] ?? 0);
const procs = new Map();
for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    const argv = read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
    const stat = read(`/proc/${pid}/stat`);
    if (!argv.length || !stat) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Field 4 is the parent, field 22 the start time in clock ticks after boot (USER_HZ is 100 on Linux).
    procs.set(Number(pid), { pid: Number(pid), argv, ppid: Number(fields[1]), start: new Date((bootTime + Number(fields[19]) / 100) * 1000) });
}
const descendants = (pid) => [...procs.values()].filter((p) => p.ppid === pid).flatMap((p) => [p, ...descendants(p.pid)]);
const lockLines = read('/proc/locks').split('\n');

for (const lock of locks) {
    let inode;
    try {
        inode = statSync(lock).ino;
    } catch {
        continue;
    }
    const entries = lockLines.filter((l) => l.includes(' FLOCK ') && l.split(/\s+/).some((f) => f.endsWith(`:${inode}`)));
    const holders = new Set(entries.filter((l) => !l.includes('->')).map((l) => Number(l.split(/\s+/)[4])));
    const flockers = [...procs.values()].filter((p) => p.argv[0].endsWith('flock') && p.argv.includes(lock));
    const rows = [...new Set([...holders, ...flockers.map((p) => p.pid)])]
        .map((pid) => ({ pid, held: holders.has(pid), p: procs.get(pid) }))
        .sort((a, b) => b.held - a.held || (a.p?.start ?? 0) - (b.p?.start ?? 0));
    console.log(rows.length ? lock : `${lock}: free`);
    for (const { pid, held, p } of rows) {
        if (!p) {
            console.log(`  holds   pid ${pid} (gone; a child kept the lock)`);
            continue;
        }
        const cmd = p.argv.slice(p.argv.indexOf(lock) + 1);
        const shown = cmd.map((a) => a.replace(/^.*\/(?=[^/]+\.(?:mjs|sh)$)/, '')).join(' ');
        const logAt = cmd.indexOf('--log');
        const log = logAt >= 0 ? cmd[logAt + 1] : cmd.find((a, i) => i > 0 && a.startsWith('/') && /log/i.test(a));
        const now = held && descendants(pid).map((d) => d.argv.find((a) => /(check-[\w-]+|capture-parity-screens)\.mjs$/.test(a))).find(Boolean);
        console.log(`  ${held ? 'holds  ' : 'waiting'} pid ${pid} since ${p.start.toLocaleString()}: ${shown.slice(0, 160)}`);
        if (now) console.log(`          running ${now.replace(/^.*\//, '')}`);
        if (log) console.log(`          log ${log}`);
    }
}
