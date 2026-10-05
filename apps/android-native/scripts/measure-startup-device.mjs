// Native Android startup measurement. Measures; changes nothing in the app.
//
//   node measure-startup-device.mjs fixture <tasks> <out.db>
//       A synthetic database made by core's own SqliteAdapter from scripts/performance/fixture.mjs (needs host `bun`).
//   node measure-startup-device.mjs seed <serial> <pkg> <seed.apk> <benchmark.apk> <db file | empty> [RKStorage file]
//       Installs the debuggable twin (build type benchmarkSeed), puts the database (and RN's AsyncStorage file, when given:
//       measure-merge-device.mjs's sync settings) in place with run-as, then installs the benchmark build over it (same id and
//       key: the data stays). Only for the benchmark package: never the dev app's data.
//   node measure-startup-device.mjs run <serial> <pkg> <label> <out dir> [runs=10] [modes=cold,warm,hot] [compile=keep]
//       `runs` samples per mode after one discarded warm-up. cold = force-stop; warm = a new task on the live process (the
//       Activity and its screen are made again, the host is reused); hot = HOME, then launch. Each sample: am start -W's
//       LaunchState, TotalTime (time to first frame) and WaitTime, and the "Fully drawn" time the Inbox's first rows
//       report (ReportDrawnWhen, InboxScreen.kt; cold and warm only). A sample whose LaunchState is not its mode, or that
//       never reports Fully drawn, fails the run. compile=verify|speed-profile|speed recompiles the app first (ART).
//   node measure-startup-device.mjs trace <serial> <pkg> <out.perfetto-trace>
//       One cold start under Perfetto: app trace sections (atrace_apps), scheduler, and the system's startup slices.
//
// Every phone command runs inside the coordinator's lock: flock -w 14400 /home/dd/scratch/s23.lock node ...
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADB = process.env.ADB ?? '/opt/android-sdk/platform-tools/adb';
const DB = 'mindwtr-native-dev.db';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const [command, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const device = (serial) => {
    const adb = (...a) => execFileSync(ADB, ['-s', serial, ...a], { maxBuffer: 64 << 20 }).toString('utf8');
    const sh = (c) => adb('shell', c).replace(/\r/g, '').trim();
    return { adb, sh };
};

const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { n: sorted.length, median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted.at(-1) };
};

if (command === 'fixture') {
    const [count, out] = args;
    rmSync(out, { force: true });
    execFileSync('bun', ['-e', `
        import { Database } from 'bun:sqlite';
        import { SqliteAdapter } from '${repo}/packages/core/src/index.ts';
        import { fixture } from '${repo}/scripts/performance/fixture.mjs';
        const db = new Database(process.env.OUT);
        const client = {
            run: async (sql, params = []) => { db.query(sql).run(...params); },
            all: async (sql, params = []) => db.query(sql).all(...params),
            get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
            exec: async (sql) => { db.exec(sql); },
        };
        const f = fixture(Number(process.env.COUNT));
        const adapter = new SqliteAdapter(client);
        await adapter.saveData(f.data);
        const back = await adapter.getData();
        if (back.tasks.length !== f.data.tasks.length) throw new Error('fixture read back ' + back.tasks.length + ' tasks');
        db.exec('PRAGMA journal_mode = DELETE');
        db.close();
        console.log(f.id + ' tasks=' + back.tasks.length);
    `], { stdio: 'inherit', env: { ...process.env, OUT: resolve(out), COUNT: count } });
} else if (command === 'seed') {
    const [serial, pkg, seedApk, benchApk, db, rkStorage] = args;
    if (!pkg.endsWith('.benchmark')) throw new Error(`REFUSED: ${pkg} is not a benchmark package`);
    const { adb, sh } = device(serial);
    adb('install', '-r', seedApk);
    sh(`am force-stop ${pkg}`);
    const runAs = (c) => sh(`run-as ${pkg} ${c}`);
    // The whole app state goes: database, its recovery checkpoint, the journal, device writes and screen state, and RN's
    // RKStorage under databases/ (a sync backend left there ran sync cycles over the 5,000 tasks into the warm starts).
    runAs('rm -rf files no_backup shared_prefs cache databases');
    runAs('mkdir -p files');
    if (db !== 'empty') {
        const staged = `/data/local/tmp/${pkg}.seed.db`;
        adb('push', db, staged);
        try { runAs(`cp ${staged} files/${DB}`); } finally { sh(`rm -f ${staged}`); }
    }
    if (rkStorage) {
        const staged = `/data/local/tmp/${pkg}.seed.rk`;
        adb('push', rkStorage, staged);
        runAs('rm -rf databases');
        runAs('mkdir -p databases');
        try { runAs(`cp ${staged} databases/RKStorage`); } finally { sh(`rm -f ${staged}`); }
    }
    adb('install', '-r', benchApk);
    console.log(`seeded ${pkg} with ${db}`);
} else if (command === 'run') {
    const [serial, pkg, label, outDir, runsText = '10', modesText = 'cold,warm,hot', compile = 'keep'] = args;
    const runs = Number(runsText);
    const { adb, sh } = device(serial);
    const activity = `${pkg}/${pkg}.MainActivity`;
    if (compile !== 'keep') sh(`cmd package compile -m ${compile} -f ${pkg}`);
    const conditions = () => ({
        at: new Date().toISOString(),
        battery: sh('dumpsys battery').split('\n').filter((l) => /level|temperature|powered/.test(l)).map((l) => l.trim()),
        thermal: sh('dumpsys thermalservice').split('\n').find((l) => /Thermal Status/.test(l))?.trim(),
    });
    const dexopt = sh(`dumpsys package dexopt`).split('\n');
    const at = dexopt.findIndex((l) => l.includes(`[${pkg}]`));
    const compiled = at < 0 ? 'unknown' : dexopt.slice(at + 1, at + 4).map((l) => l.trim()).join(' | ');
    const phoneTime = () => sh('date +%s.%3N');
    const fullyDrawn = async (since) => {
        for (let i = 0; i < 100; i += 1) {
            const line = adb('logcat', '-d', '-v', 'epoch', '-T', since, '-s', 'ActivityTaskManager:I')
                .split('\n').find((l) => l.includes(`Fully drawn ${pkg}/`));
            const match = line && /\+(?:(\d+)s)?(\d+)ms/.exec(line);
            if (match) return Number(match[1] ?? 0) * 1000 + Number(match[2]);
            await sleep(200);
        }
        return null;
    };
    const home = () => sh('input keyevent KEYCODE_HOME');
    const launch = (flags = '') => {
        const out = sh(`am start -W ${flags} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`);
        const field = (name) => out.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.split(':')[1]?.trim();
        return { state: field('LaunchState'), total: Number(field('TotalTime')), wait: Number(field('WaitTime')) };
    };
    const sample = async (mode) => {
        if (mode === 'cold') { sh(`am force-stop ${pkg}`); await sleep(1000); }
        if (mode === 'hot') { home(); await sleep(1000); }
        if (mode === 'warm') { home(); await sleep(1000); }
        const since = phoneTime();
        // warm: NEW_TASK | CLEAR_TASK finishes the running Activity and makes a new one in the same process.
        const result = launch(mode === 'warm' ? '-f 0x10008000' : '');
        const drawn = mode === 'hot' ? null : await fullyDrawn(since);
        await sleep(1500); // the screen's own reads after first content end before the next sample
        const pid = sh(`pidof ${pkg}`);
        return { mode, ...result, fullyDrawn: drawn, pid };
    };
    const report = { label, pkg, serial, compiled, runs, before: conditions(), samples: [] };
    const modes = modesText.split(',');
    for (const mode of modes) {
        if (mode !== 'cold') { sh(`am force-stop ${pkg}`); launch(); await fullyDrawn(phoneTime()); await sleep(1500); }
        await sample(mode); // discarded warm-up
        for (let i = 0; i < runs; i += 1) {
            const s = await sample(mode);
            const bad = s.state?.toUpperCase() !== mode.toUpperCase() || !(s.total > 0) || (mode !== 'hot' && s.fullyDrawn == null);
            report.samples.push({ ...s, valid: !bad });
            console.log(`${label} ${mode} #${i + 1}: state=${s.state} total=${s.total} wait=${s.wait} fullyDrawn=${s.fullyDrawn}${bad ? ' INVALID' : ''}`);
        }
    }
    report.after = conditions();
    report.summary = Object.fromEntries(modes.map((mode) => {
        const valid = report.samples.filter((s) => s.mode === mode && s.valid);
        return [mode, { totalTime: stats(valid.map((s) => s.total)), fullyDrawn: mode === 'hot' ? null : stats(valid.map((s) => s.fullyDrawn)),
            invalid: report.samples.filter((s) => s.mode === mode && !s.valid).length }];
    }));
    home();
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `${label}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.summary));
    console.log(`wrote ${file}`);
    if (report.samples.some((s) => !s.valid)) process.exitCode = 1;
} else if (command === 'trace') {
    const [serial, pkg, out] = args;
    const { adb, sh } = device(serial);
    const activity = `${pkg}/${pkg}.MainActivity`;
    const remote = `/data/misc/perfetto-traces/${pkg}-startup.perfetto-trace`;
    const config = `
buffers { size_kb: 131072 fill_policy: RING_BUFFER }
data_sources { config { name: "linux.ftrace" ftrace_config {
    ftrace_events: "sched/sched_switch" ftrace_events: "sched/sched_wakeup" ftrace_events: "sched/sched_waking"
    ftrace_events: "sched/sched_blocked_reason" ftrace_events: "power/cpu_frequency" ftrace_events: "task/task_newtask"
    ftrace_events: "task/task_rename" ftrace_events: "sched/sched_process_exit" ftrace_events: "sched/sched_process_free"
    atrace_categories: "am" atrace_categories: "wm" atrace_categories: "view" atrace_categories: "gfx" atrace_categories: "dalvik"
    atrace_categories: "binder_driver" atrace_categories: "res" atrace_categories: "bionic" atrace_categories: "pm" atrace_categories: "disk"
    atrace_apps: "${pkg}"
} } }
data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }
data_sources { config { name: "android.packages_list" } }
duration_ms: 12000
`;
    sh(`am force-stop ${pkg}`);
    await sleep(1500);
    const tracer = execFileSync(ADB, ['-s', serial, 'shell', `perfetto --txt -c - -o ${remote} --background`], { input: config }).toString();
    await sleep(2000);
    console.log(sh(`am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`));
    for (let i = 0; i < 80 && sh('pidof perfetto || true'); i += 1) await sleep(250);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    adb('pull', remote, resolve(out));
    sh(`rm -f ${remote}`);
    sh('input keyevent KEYCODE_HOME');
    console.log(`${tracer.trim()} -> ${out}${existsSync(out) ? '' : ' (missing)'}`);
} else {
    console.error('usage: fixture | seed | run | trace (see the header)');
    process.exit(2);
}
