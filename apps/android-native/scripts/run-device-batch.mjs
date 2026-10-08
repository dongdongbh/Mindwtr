// Runs the native Android device checks as one batch on the shared S23 test phone, under /home/dd/scratch/s23.lock.
//
//   node apps/android-native/scripts/run-device-batch.mjs [--tree <worktree>] [--harness <dir>] [--log <dir>] [--no-build]
//       [--detach [--unit <name>]] [check names...]
//
// It builds the bundle, the four Gradle variants and the upgrade harness, and stops before any check when one of them fails
// (`STOP: <step> failed`). Each check then starts from the home screen with rotation on, runs for at most an hour and adds
// `## <check> HH:MM` and `EXIT=<code> rotation=<r>` to <log>/summary.txt (its output goes to <log>/<check>.log). The last line
// of summary.txt is `VERDICT PASS <n>/<n>` or `VERDICT FAIL <passed>/<n>: <failed checks>`; the exit code is 0 only on PASS.
// With no names it runs every check-*-device.mjs and capture-parity-screens.mjs in the tree (check-projects-device with
// --prune-old first, check-upgrade-device last). --detach starts the batch as a systemd user unit (a worker shell's
// background jobs die when the worker pauses) and prints the unit and the log folder. phone-queue.mjs shows who holds the
// phone and who waits.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERIAL = 'RFCW10JBP0Y';
const LOCK = '/home/dd/scratch/s23.lock';
const ADB = '/opt/android-sdk/platform-tools/adb';
const SDK = '/home/dd/Android/Sdk';
const LOCK_TIMED_OUT = 75;
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = 'apps/android-native/scripts';
const apkDir = 'apps/android-native/android/app/build/outputs/apk/play';

// The order the batch has always run in: lists first, the RN-to-native upgrade (it reinstalls the app) last.
const ORDER = ['check-projects-device', 'check-bgsync-device', 'check-encryption-device', 'check-widgets-device',
    'check-project-details-device', 'capture-parity-screens', 'check-startup-device', 'check-lifecycle-device',
    'check-editor-device', 'check-search-device', 'check-process-inbox-device', 'check-capture-device',
    'check-capture-modal-device', 'check-entry-points-device', 'check-journal-device', 'check-menu-device',
    'check-review-device', 'check-calendar-board-device', 'check-toolbars-device', 'check-settings-editor-device',
    'check-sweep-saved-device', 'check-review-organize-device', 'check-app-lock-device', 'check-net-device',
    'check-intl-device', 'check-sync-device', 'check-language-device', 'check-focus-device', 'check-log-device',
    'check-ai-device', 'check-attachments-device', 'check-reminders-device', 'check-runner-device', 'check-upgrade-device'];
const LAST = 'check-upgrade-device';

export function parseArgs(argv) {
    const opts = { tree: resolve(here, '../../..'), harness: null, log: null, build: true, detach: false, unit: null, checks: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--tree') opts.tree = resolve(value());
        else if (a === '--harness') opts.harness = resolve(value());
        else if (a === '--log') opts.log = resolve(value());
        else if (a === '--unit') opts.unit = value();
        else if (a === '--no-build') opts.build = false;
        else if (a === '--detach') opts.detach = true;
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else opts.checks.push(a.replace(/\.mjs$/, ''));
    }
    return opts;
}

// Every check script in the tree, in ORDER; a check ORDER does not know yet runs before the upgrade check.
export function defaultChecks(names) {
    const found = names.map((n) => n.replace(/\.mjs$/, '')).filter((n) => /^check-[\w-]+-device$|^capture-parity-screens$/.test(n));
    const known = ORDER.filter((n) => found.includes(n) && n !== LAST);
    const fresh = found.filter((n) => !ORDER.includes(n)).sort();
    return [...known, ...fresh, ...(found.includes(LAST) ? [LAST] : [])];
}

export function verdict(results) {
    const failed = results.filter((r) => r.exit !== 0).map((r) => r.check);
    const passed = results.length - failed.length;
    return failed.length === 0 && results.length > 0
        ? `VERDICT PASS ${passed}/${results.length}`
        : `VERDICT FAIL ${passed}/${results.length}: ${failed.join(' ') || 'no checks ran'}`;
}

export function checkArgs(check) {
    if (check === 'check-projects-device') return ['--prune-old'];
    if (check === 'check-startup-device') return [`${apkDir}/benchmarkSeed/app-play-benchmarkSeed.apk`, `${apkDir}/benchmark/app-play-benchmark.apk`];
    return [];
}

const hhmm = () => new Date().toTimeString().slice(0, 5);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`run-device-batch: ${error.message}`);
        process.exit(2);
    }
    opts.log ??= `/home/dd/scratch/logs/device-batch/${stamp()}`;
    const available = readdirSync(join(opts.tree, scriptsDir));
    const checks = opts.checks.length ? opts.checks : defaultChecks(available);
    const missing = checks.filter((c) => !available.includes(`${c}.mjs`));
    if (missing.length) {
        console.error(`run-device-batch: no such check in ${opts.tree}: ${missing.join(' ')}`);
        process.exit(2);
    }
    mkdirSync(opts.log, { recursive: true });
    const self = [fileURLToPath(import.meta.url), '--tree', opts.tree, '--log', opts.log, ...(opts.harness ? ['--harness', opts.harness] : []),
        ...(opts.build ? [] : ['--no-build']), ...opts.checks];

    if (opts.detach) {
        const unit = opts.unit ?? `device-batch-${basename(opts.log)}`.replace(/[^\w.-]/g, '-');
        const env = ['PATH', 'JAVA_HOME', 'HOME'].filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`);
        // KillMode=process: the unit's end must not take down an adb server or Gradle daemon other sessions now use.
        const run = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--property=KillMode=process', `--working-directory=${opts.tree}`, ...env,
            `--property=StandardOutput=append:${opts.log}/runner.out`, `--property=StandardError=append:${opts.log}/runner.out`,
            process.execPath, ...self], { stdio: 'inherit' });
        if (run.status === 0) console.log(`unit ${unit}\nlog ${opts.log}\nverdict: tail -1 ${opts.log}/summary.txt`);
        process.exit(run.status ?? 1);
    }

    // One batch on the phone at a time: run again under the lock. -o keeps the lock out of the adb server this batch may start.
    if (!process.env.S23_LOCKED) {
        const run = spawnSync('flock', ['-o', '-E', String(LOCK_TIMED_OUT), '-w', '14400', LOCK, process.execPath, ...self],
            { stdio: 'inherit', env: { ...process.env, S23_LOCKED: '1' } });
        if (run.status === LOCK_TIMED_OUT) console.error(`STOP: ${LOCK} stayed busy for 4 hours`);
        process.exit(run.status ?? 1);
    }

    const summary = join(opts.log, 'summary.txt');
    const say = (line) => {
        console.log(line);
        appendFileSync(summary, `${line}\n`);
    };
    const env = { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK, ADB, AAPT2: '/opt/android-sdk/build-tools/36.0.0/aapt2', LC_ALL: 'en_US.UTF-8' };
    if (opts.harness) env.MINDWTR_HARNESS_DIR = opts.harness;
    const run = (cmd, args, logName, extra = {}) => {
        const fd = openSync(join(opts.log, logName), 'a');
        try {
            return spawnSync(cmd, args, { cwd: opts.tree, env, stdio: ['ignore', fd, fd], ...extra }).status ?? 1;
        } finally {
            closeSync(fd);
        }
    };
    const adb = (...args) => spawnSync(ADB, ['-s', SERIAL, 'shell', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout?.trim() ?? '';
    const finish = (results) => {
        adb('settings', 'put', 'system', 'accelerometer_rotation', '1');
        say(`end ${new Date().toString()} rotation=${adb('settings', 'get', 'system', 'accelerometer_rotation')}`);
        const line = verdict(results);
        say(line);
        process.exit(line.startsWith('VERDICT PASS') ? 0 : 1);
    };

    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.tree, encoding: 'utf8' }).stdout.trim();
    say(`start ${new Date().toString()} tree ${opts.tree} head ${head} harness ${opts.harness ?? env.MINDWTR_HARNESS_DIR ?? '(default)'}`);
    if (opts.build) {
        const steps = [
            ['bundle', process.execPath, [`${scriptsDir}/build-bundle.mjs`]],
            ['gradle', './gradlew', [':app:assembleDebug', ':app:assembleUpgradetest', ':app:assemblePlayBenchmark', ':app:assemblePlayBenchmarkSeed', '--offline', '-q'],
                { cwd: join(opts.tree, 'apps/android-native/android') }],
            ['harness', process.execPath, [`${scriptsDir}/build-upgrade-harness.mjs`]],
        ];
        for (const [name, cmd, args, extra] of steps) {
            const code = run(cmd, args, `${name}.log`, extra);
            say(`${name}=${code}`);
            if (name === 'gradle' && code === 0) {
                const apk = join(opts.tree, apkDir, 'debug/app-play-debug.apk');
                const sha = spawnSync('sha256sum', [apk], { encoding: 'utf8' }).stdout.slice(0, 12);
                say(`apk sha ${sha}`);
            }
            if (code !== 0) {
                say(`STOP: ${name} failed (${opts.log}/${name}.log)`);
                say(`VERDICT FAIL 0/${checks.length}: not run, ${name} failed`);
                process.exit(1);
            }
        }
    }

    const results = [];
    for (const check of checks) {
        if (!adb('dumpsys', 'activity', 'activities').split('\n').find((l) => l.includes('topResumedActivity'))?.includes('launcher')) {
            adb('input', 'keyevent', 'KEYCODE_HOME');
        }
        adb('settings', 'put', 'system', 'accelerometer_rotation', '1');
        say(`## ${check} ${hhmm()}`);
        const code = run('timeout', ['3600', process.execPath, `${scriptsDir}/${check}.mjs`, SERIAL, ...checkArgs(check)], `${check}.log`);
        say(`EXIT=${code} rotation=${adb('settings', 'get', 'system', 'accelerometer_rotation')}`);
        results.push({ check, exit: code });
    }
    finish(results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
