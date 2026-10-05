// Native Android sync-merge measurement (ADR 0029 item 3, D9). Measures; changes nothing in the app.
//
//   node measure-merge-device.mjs rkstorage <out file> <port>
//       RN's AsyncStorage file (databases/RKStorage) holding only a WebDAV sync setting for this computer's folder on
//       127.0.0.1:<port> (no user, no password, plain http allowed). Seed it with the database:
//       measure-startup-device.mjs seed <serial> <pkg> <seed.apk> <benchmark.apk> <db> <this file>.
//   node measure-merge-device.mjs run <serial> <pkg> <label> <out dir> [samples=10] [changes=250] [taps=on] [push=off] [start=cold]
//       Serves an in-memory WebDAV folder (sync-harness.mjs serveWebdav, no auth) on 127.0.0.1:18781 through adb reverse.
//       A first cold start uploads the library and a second one settles it; neither is measured. Then each sample: the folder's
//       document gets `changes` tasks edited on this computer (title, a newer rev and updatedAt), the app starts cold under
//       Perfetto, and its boot sync merges them. With push on, one more task goes back to an older revision in the folder,
//       so the phone's newer copy wins the merge and the cycle writes the document back (otherwise the merged document
//       equals the folder's and the remote write is skipped). With start=resume the process lives on between samples: the
//       folder is edited, HOME, then the app comes back (its resume sync, in a process that has synced and saved before). With taps on, the phone taps the Focus and Inbox tabs in turn every
//       ~0.6 s from launch: each tap starts a core read, so the trace shows how long a screen command waits while sync runs.
//       Traces go to <out dir>/<label>-<n>.perfetto-trace, the summary to <out dir>/<label>.json.
//   node measure-merge-device.mjs analyze <trace>...
//       Per trace: the sync's engine-thread sections (sync:*, io:*, sql:*), the engine's uninterrupted blocks during sync,
//       the engine thread's states, and each screen command's wait (core:wait on its own thread) with its queue time and the
//       tap before it. With --budget=<ms> it exits 1 unless the p90 tap-to-answer of the taps whose wait began inside the
//       sync's span is at most <ms> (D9's target is 300); no such tap also fails.
//
// Every phone command runs inside the coordinator's lock: flock -o -w 14400 /home/dd/scratch/s23.lock node ...
// Only the benchmark package (its own application id): the dev app's data is never touched.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serveWebdav } from './sync-harness.mjs';

const ADB = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
const TP = process.env.TRACE_PROCESSOR ?? '/home/dd/.cache/mindwtr-performance-tmp/mindwtr-perfetto/trace_processor';
const PORT = 18781;
const FOLDER = '/dav/merge-bench';
const TAG = 'MindwtrNativeDev';
const here = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const stats = (values) => {
    const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (sorted.length === 0) return { n: 0 };
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    const round = (v) => Math.round(v * 10) / 10;
    return { n: sorted.length, median: round(at(0.5)), p90: round(at(0.9)), min: round(sorted[0]), max: round(sorted.at(-1)) };
};

const sqlite3 = (file, sql) => execFileSync('sqlite3', [file, sql], { encoding: 'utf8' });

if (command === 'rkstorage') {
    const [out, port = String(PORT)] = args;
    rmSync(out, { force: true });
    // RN's AsyncStorage schema at user_version 1 (RnKeyValue.kt), with core's sync keys (sync-storage-keys.ts).
    const rows = [
        ['@mindwtr_sync_backend', 'webdav'],
        ['@mindwtr_webdav_url', `http://127.0.0.1:${port}${FOLDER}`],
        ['@mindwtr_webdav_username', ''],
        ['@mindwtr_webdav_allow_insecure_http', 'true'],
    ];
    sqlite3(out, `CREATE TABLE catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL); ${rows.map(([k, v]) => `INSERT INTO catalystLocalStorage VALUES ('${k}', '${v}');`).join(' ')} PRAGMA user_version = 1;`);
    console.log(`wrote ${out}`);
} else if (command === 'run') {
    const [serial, pkg, label, outDir, samplesText = '10', changesText = '250', tapsText = 'on', pushText = 'off', startText = 'cold'] = args;
    if (!pkg.endsWith('.benchmark')) throw new Error(`REFUSED: ${pkg} is not a benchmark package`);
    const samples = Number(samplesText);
    const changes = Number(changesText);
    const taps = tapsText === 'on';
    const push = pushText === 'on';
    const resume = startText === 'resume';
    const adb = (...a) => execFileSync(ADB, ['-s', serial, ...a], { maxBuffer: 256 << 20 }).toString('utf8');
    const sh = (c) => adb('shell', c).replace(/\r/g, '').trim();
    const activity = `${pkg}/${pkg}.MainActivity`;
    mkdirSync(outDir, { recursive: true });

    const dav = await serveWebdav({ port: PORT, username: '', password: '', open: true });
    adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
    const documentPath = `${FOLDER}/data.json`;
    let etagVersion = 0;
    /** The folder's document with [count] tasks edited as another device would: a new title, a newer rev and updatedAt. */
    const editRemote = (round) => {
        const file = dav.state.files.get(documentPath);
        if (!file) throw new Error('the folder holds no sync document yet');
        const doc = JSON.parse(file.body.toString('utf8'));
        const sorted = doc.tasks.filter((task) => !task.deletedAt).sort((a, b) => (a.id < b.id ? -1 : 1));
        const live = sorted.slice(0, changes);
        const older = push && round > 0 ? sorted[changes] : null;
        if (older) {
            older.title = `${older.title.replace(/ \(older \d+\)$/, '')} (older ${round})`;
            older.rev = Math.max(0, (older.rev ?? 1) - 1);
            older.updatedAt = '2020-01-01T00:00:00.000Z';
        }
        const now = new Date().toISOString();
        for (const task of live) {
            task.title = `${task.title.replace(/ \(remote \d+\)$/, '')} (remote ${round})`;
            task.updatedAt = now;
            task.rev = (task.rev ?? 0) + 1;
            task.revBy = 'merge-bench-remote';
        }
        const body = Buffer.from(JSON.stringify(doc, null, 2));
        dav.state.files.set(documentPath, { body, etag: `"bench-${++etagVersion}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}"` });
        return { tasks: doc.tasks.length, edited: live.length, bytes: body.length };
    };
    const phoneTime = () => sh('date +%s.%3N');
    /** Core's last line of a sync cycle after [since] (mobile-sync-service.ts: complete, or error). */
    const cycleEnded = async (since, timeoutMs = 90_000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const lines = adb('logcat', '-d', '-v', 'epoch', '-T', since, '-s', `${TAG}:I`).split('\n');
            const ended = lines.find((line) => /Sync diagnostic (complete|error)/.test(line));
            if (ended) return { line: ended.trim(), syncLines: lines.filter((line) => /Sync step|Full sync merge|Sync local reconcile|sync state|Sync diagnostic/.test(line)).map((l) => l.trim()) };
            await sleep(500);
        }
        return null;
    };
    const launchCold = async () => {
        sh(`am force-stop ${pkg}`);
        await sleep(1000);
        const since = phoneTime();
        sh(`am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`);
        return since;
    };

    // Warm-up: the first start uploads the library (an empty folder), the second merges a first edit; neither is measured.
    const warm1 = await cycleEnded(await launchCold());
    if (!warm1 || !dav.state.files.get(documentPath)) throw new Error(`warm-up: no sync document uploaded (${warm1?.line ?? 'no cycle'})`);
    console.log(`warm-up 1: ${warm1.line}`);

    // The tab bar's Focus and Inbox tabs, from one UI dump (core's English labels).
    let targets = null;
    if (taps) {
        sh('uiautomator dump /data/local/tmp/merge-bench-ui.xml >/dev/null');
        const xml = sh('cat /data/local/tmp/merge-bench-ui.xml');
        const nodes = [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => Object.fromEntries([...n.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])));
        const centre = (text) => {
            const node = nodes.filter((n) => n.text === text).map((n) => n.bounds.match(/\d+/g).map(Number)).sort((a, b) => b[1] - a[1])[0];
            return node ? [Math.round((node[0] + node[2]) / 2), Math.round((node[1] + node[3]) / 2)] : null;
        };
        targets = { focus: centre('Focus'), inbox: centre('Inbox') };
        if (!targets.focus || !targets.inbox) throw new Error(`tab bar not found: ${JSON.stringify(targets)}`);
        console.log(`tap targets ${JSON.stringify(targets)}`);
    }
    editRemote(0);
    const warm2 = await cycleEnded(await launchCold());
    if (!warm2) throw new Error('warm-up 2: no sync cycle ended');
    console.log(`warm-up 2: ${warm2.line}`);

    const config = `
buffers { size_kb: 262144 fill_policy: RING_BUFFER }
data_sources { config { name: "linux.ftrace" ftrace_config {
    ftrace_events: "sched/sched_switch" ftrace_events: "sched/sched_wakeup" ftrace_events: "sched/sched_waking"
    ftrace_events: "sched/sched_blocked_reason" ftrace_events: "power/cpu_frequency" ftrace_events: "task/task_newtask"
    ftrace_events: "task/task_rename" ftrace_events: "sched/sched_process_exit" ftrace_events: "sched/sched_process_free"
    atrace_categories: "am" atrace_categories: "wm" atrace_categories: "view" atrace_categories: "gfx" atrace_categories: "input"
    atrace_categories: "dalvik" atrace_categories: "binder_driver"
    atrace_apps: "${pkg}"
} } }
data_sources { config { name: "android.log" android_log_config { min_prio: PRIO_INFO filter_tags: "${TAG}" } } }
data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }
data_sources { config { name: "android.packages_list" } }
duration_ms: 16000
`;
    const conditions = () => ({
        at: new Date().toISOString(),
        battery: sh('dumpsys battery').split('\n').filter((l) => /level|temperature|powered/.test(l)).map((l) => l.trim()),
        thermal: sh('dumpsys thermalservice').split('\n').find((l) => /Thermal Status/.test(l))?.trim(),
    });
    const report = { label, pkg, serial, samples, changes, taps, push, resume, targets, before: conditions(), runs: [] };
    for (let round = 1; round <= samples; round += 1) {
        // resume: a live process that has finished its own sync (a cold start's, the first time).
        if (resume && !sh(`pidof ${pkg} || true`)) {
            if (!await cycleEnded(await launchCold())) throw new Error('resume: the cold start before the sample did not sync');
            await sleep(3000);
        }
        const remote = editRemote(round);
        if (!resume) sh(`am force-stop ${pkg}`);
        await sleep(1000);
        const remoteTrace = `/data/misc/perfetto-traces/${pkg}-merge.perfetto-trace`;
        execFileSync(ADB, ['-s', serial, 'shell', `perfetto --txt -c - -o ${remoteTrace} --background`], { input: config });
        await sleep(2000);
        // resume: leaving asks for a sync that waits while the app is away; coming back runs it.
        if (resume) { sh('input keyevent KEYCODE_HOME'); await sleep(1500); }
        const since = phoneTime();
        // The taps run on the phone, from launch: Focus, Inbox, Focus, ... (each tab's show reads it from core).
        let tapper = null;
        if (taps) {
            const steps = [];
            for (let i = 0; i < 9; i += 1) steps.push(`input tap ${(i % 2 ? targets.inbox : targets.focus).join(' ')}; sleep 0.4`);
            const child = spawn(ADB, ['-s', serial, 'shell', `sleep 0.3; ${steps.join('; ')}`], { stdio: 'ignore' });
            tapper = new Promise((done) => child.on('exit', done));
        }
        sh(`am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`);
        const ended = await cycleEnded(since);
        if (tapper) await tapper;
        for (let i = 0; i < 80 && sh('pidof perfetto || true'); i += 1) await sleep(250);
        const trace = resolve(outDir, `${label}-${round}.perfetto-trace`);
        adb('pull', remoteTrace, trace);
        sh(`rm -f ${remoteTrace}`);
        report.runs.push({ round, remote, trace, ended: ended?.line ?? null, syncLines: ended?.syncLines ?? [] });
        console.log(`${label} #${round}: ${ended?.line ?? 'NO CYCLE'} -> ${trace}`);
    }
    report.after = conditions();
    sh('input keyevent KEYCODE_HOME');
    adb('reverse', '--remove', `tcp:${PORT}`);
    await dav.close();
    const file = resolve(outDir, `${label}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`wrote ${file}`);
    if (report.runs.some((run) => !run.ended)) process.exitCode = 1;
} else if (command === 'analyze') {
    const PKG_GLOB = '*.benchmark';
    const query = (trace, sql) => {
        const file = join(tmpdir(), `merge-q-${process.pid}.sql`);
        writeFileSync(file, sql);
        try {
            const out = execFileSync(TP, ['-q', file, trace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
            const lines = out.trim().split('\n').filter((l) => l.startsWith('"') || /^[\d-]/.test(l));
            const header = out.trim().split('\n').find((l) => l.startsWith('"'));
            if (!header) return [];
            const keys = header.split(',').map((k) => k.replace(/"/g, ''));
            return lines.filter((l) => l !== header).map((l) => {
                const values = l.match(/("([^"]*)"|[^,]+)/g).map((v) => v.replace(/^"|"$/g, ''));
                return Object.fromEntries(keys.map((k, i) => [k, Number.isNaN(Number(values[i])) || values[i] === '' ? values[i] : Number(values[i])]));
            });
        } finally { rmSync(file, { force: true }); }
    };
    const engine = `(SELECT utid FROM thread JOIN process USING (upid) WHERE thread.name = 'mindwtr-core' AND process.name GLOB '${PKG_GLOB}' ORDER BY thread.start_ts DESC LIMIT 1)`;
    const budgetArg = args.find((a) => a.startsWith('--budget='));
    const budgetMs = budgetArg ? Number(budgetArg.slice('--budget='.length)) : null;
    const results = [];
    for (const trace of args.filter((a) => a !== budgetArg)) {
        // The sync's span on the engine: its first and last sync:* section.
        const [span] = query(trace, `
SELECT MIN(s.ts) AS start, MAX(s.ts + s.dur) AS end FROM slice s JOIN thread_track tt ON s.track_id = tt.id
WHERE tt.utid = ${engine} AND s.name GLOB 'sync:*';`);
        if (!span || !span.start) { results.push({ trace, error: 'no sync sections' }); continue; }
        const window = `s.ts < ${span.end} AND s.ts + s.dur > ${span.start}`;
        // Uninterrupted engine work: each top-level slice on the engine thread that overlaps the sync.
        const blocks = query(trace, `
SELECT s.id, s.name, s.ts, round(s.dur / 1e6, 1) AS ms,
  (SELECT group_concat(name, '|') FROM (SELECT DISTINCT d.name FROM descendant_slice(s.id) d WHERE d.name GLOB 'sync:*' OR d.name GLOB 'io:*')) AS inner
FROM slice s JOIN thread_track tt ON s.track_id = tt.id
WHERE tt.utid = ${engine} AND s.depth = 0 AND ${window} ORDER BY s.dur DESC;`);
        // Sections by name, outermost occurrence only (sync:merge inside sync:saveData would count twice otherwise).
        const sections = query(trace, `
SELECT s.name, COUNT(*) AS n, round(SUM(s.dur) / 1e6, 1) AS ms, round(MAX(s.dur) / 1e6, 1) AS maxMs
FROM slice s JOIN thread_track tt ON s.track_id = tt.id
WHERE tt.utid = ${engine} AND ${window} AND (s.name GLOB 'sync:*' OR s.name GLOB 'io:*' OR s.name GLOB 'sql:*' OR s.name GLOB 'core:*')
GROUP BY s.name ORDER BY SUM(s.dur) DESC;`);
        const states = query(trace, `
SELECT state, round(SUM(MIN(ts + dur, ${span.end}) - MAX(ts, ${span.start})) / 1e6, 1) AS ms FROM thread_state
WHERE utid = ${engine} AND ts < ${span.end} AND ts + dur > ${span.start} GROUP BY state ORDER BY ms DESC;`);
        // Each host call: its caller's core:wait (queue + run), its own engine slice (the last core:* slice to end inside the
        // wait), the sync work the engine did meanwhile (sync:*/io:* sections, outermost), and the tap before it when one
        // came within 150 ms (a tab's read: deliverInputEvent on the app's main thread).
        const syncWork = `(SELECT COALESCE(SUM(MIN(d.ts + d.dur, s.ts + s.dur) - MAX(d.ts, s.ts)), 0) FROM slice d JOIN thread_track dt ON d.track_id = dt.id
     WHERE dt.utid = ${engine} AND (d.name GLOB 'sync:*' OR d.name GLOB 'io:*') AND d.ts < s.ts + s.dur AND d.ts + d.dur > s.ts
     AND NOT EXISTS (SELECT 1 FROM ancestor_slice(d.id) a WHERE a.name GLOB 'sync:*' OR a.name GLOB 'io:*'))`;
        const own = `FROM slice e JOIN thread_track et ON e.track_id = et.id WHERE et.utid = ${engine} AND e.depth = 0 AND e.name GLOB 'core:*'
     AND e.name != 'core:idlePump' AND e.ts >= s.ts AND e.ts + e.dur <= s.ts + s.dur ORDER BY e.ts + e.dur DESC LIMIT 1`;
        const waits = query(trace, `
SELECT s.ts, round(s.dur / 1e6, 1) AS waitMs, t.name AS thread,
  (SELECT e.name ${own}) AS op,
  (SELECT round((e.ts - s.ts) / 1e6, 1) ${own}) AS queueMs,
  (SELECT round(e.dur / 1e6, 1) ${own}) AS runMs,
  round(${syncWork} / 1e6, 1) AS syncWorkMs,
  (SELECT round((s.ts + s.dur - i.ts) / 1e6, 1) FROM slice i JOIN thread_track it ON i.track_id = it.id JOIN thread ti USING (utid) JOIN process pi USING (upid)
     WHERE pi.name GLOB '${PKG_GLOB}' AND ti.tid = pi.pid AND i.name GLOB 'deliverInputEvent*' AND i.ts <= s.ts AND i.ts > s.ts - 150e6 ORDER BY i.ts DESC LIMIT 1) AS tapToAnswerMs,
  round((s.ts - ${span.start}) / 1e6, 1) AS atSyncMs
FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING (utid) JOIN process p USING (upid)
WHERE p.name GLOB '${PKG_GLOB}' AND s.name = 'core:wait' AND tt.utid != ${engine} ORDER BY s.ts;`)
            .map((w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v === '[NULL]' ? null : v])));
        const steps = query(trace, `
SELECT round((ts - ${span.start}) / 1e6, 1) AS atSyncMs, replace(replace(msg, ',', ';'), '"', '') AS msg FROM android_logs WHERE tag = '${TAG}'
  AND (msg GLOB '*Sync step*' OR msg GLOB '*Full sync merge*' OR msg GLOB '*Sync local reconcile*' OR msg GLOB '*sync state*') ORDER BY ts;`);
        results.push({
            trace, syncSpanMs: Math.round((span.end - span.start) / 1e5) / 10,
            longestBlocks: blocks.slice(0, 6).map(({ name, ms, inner }) => ({ name, ms, inner })),
            sections, states, waits, steps,
        });
    }
    // Across traces: the sync's sections (median of each sample's total), its longest block, and the waits behind sync vs idle.
    const byName = {};
    for (const r of results.filter((r) => !r.error)) for (const s of r.sections) (byName[s.name] ??= []).push(s.ms);
    const waits = results.flatMap((r) => r.waits ?? []).filter((w) => w.op);
    // A tap's read (a wait with a tap before it) during sync work (more than 10 ms of it inside the wait) or not.
    const tapWaits = (during) => {
        const chosen = waits.filter((w) => w.tapToAnswerMs != null && (w.syncWorkMs > 10) === during);
        return { tapToAnswerMs: stats(chosen.map((w) => w.tapToAnswerMs)), waitMs: stats(chosen.map((w) => w.waitMs)), queueMs: stats(chosen.map((w) => w.queueMs)), runMs: stats(chosen.map((w) => w.runMs)) };
    };
    const ok = results.filter((r) => !r.error);
    const summary = {
        traces: results.length,
        syncSpanMs: stats(ok.map((r) => r.syncSpanMs)),
        longestBlockMs: stats(ok.map((r) => r.longestBlocks[0]?.ms ?? 0)),
        engineRunningMs: stats(ok.map((r) => r.states.filter((x) => x.state === 'Running').reduce((a, x) => a + x.ms, 0))),
        sections: Object.fromEntries(Object.entries(byName).map(([name, values]) => [name, stats(values)]).sort((a, b) => (b[1].median ?? 0) - (a[1].median ?? 0))),
        tapsDuringSync: tapWaits(true),
        tapsOutsideSync: tapWaits(false),
        // Every host call that waited while sync work ran on the engine (taps, the screens' own reads, workers).
        // A tap whose wait began inside the sync's span (its first to last sync section), whatever ran in the wait.
        tapsInSyncSpan: stats(ok.flatMap((r) => r.waits.filter((w) => w.tapToAnswerMs != null && w.atSyncMs >= 0 && w.atSyncMs <= r.syncSpanMs).map((w) => w.tapToAnswerMs))),
        callsDuringSync: { n: waits.filter((w) => w.syncWorkMs > 10).length, waitMs: stats(waits.filter((w) => w.syncWorkMs > 10).map((w) => w.waitMs)), syncWorkMs: stats(waits.filter((w) => w.syncWorkMs > 10).map((w) => w.syncWorkMs)) },
    };
    console.log(JSON.stringify({ summary, results }, null, 2));
    if (budgetMs !== null && !(summary.tapsInSyncSpan.p90 <= budgetMs)) {
        console.error(`budget failed: tap in sync span p90 ${summary.tapsInSyncSpan.p90 ?? 'none'} ms > ${budgetMs} ms (n ${summary.tapsInSyncSpan.n})`);
        process.exitCode = 1;
    }
} else {
    console.error('usage: rkstorage | run | analyze (see the header)');
    process.exit(2);
}
