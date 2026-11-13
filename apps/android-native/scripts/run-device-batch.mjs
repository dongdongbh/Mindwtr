


import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERIAL = 'RFCW10JBP0Y';
const LOCK = '/home/dd/scratch/s23.lock';
const ADB = '/opt/android-sdk/platform-tools/adb';
const ADB_PORT = '5038';
const SDK = '/home/dd/Android/Sdk';
const LOCK_TIMED_OUT = 75;
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = 'apps/android-native/scripts';
const apkRoot = 'apps/android-native/android/app/build/outputs/apk';
const PLAY_APK = 'play/debug/app-play-debug.apk';
const FOSS_APK = 'foss/debug/app-foss-debug.apk';
const SEED_APK = 'play/benchmarkSeed/app-play-benchmarkSeed.apk';
const BENCHMARK_APK = 'play/benchmark/app-play-benchmark.apk';


const ORDER = ['check-projects-device', 'check-bgsync-device', 'check-encryption-device', 'check-widgets-device',
    'check-project-details-device', 'capture-parity-screens', 'check-startup-device', 'check-lifecycle-device',
    'check-editor-device', 'check-search-device', 'check-process-inbox-device', 'check-capture-device',
    'check-capture-modal-device', 'check-entry-points-device', 'check-share-files-device', 'check-journal-device', 'check-menu-device',
    'check-review-device', 'check-calendar-board-device', 'check-calendar-push-device', 'check-toolbars-device', 'check-settings-editor-device',
    'check-sweep-saved-device', 'check-review-organize-device', 'check-app-lock-device', 'check-net-device',
    'check-intl-device', 'check-sync-device', 'check-language-device', 'check-focus-device', 'check-log-device',
    'check-ai-device', 'check-attachments-device', 'check-continue-without-files-device', 'check-reminders-device', 'check-runner-device',
    'check-upgrade-device'];
const LAST = 'check-upgrade-device';
export const DISPOSABLE_PACKAGES = ['tech.dongdongbh.mindwtr.nativeclient.dev', 'tech.dongdongbh.mindwtr.upgradetest'];


export const KNOWN_STALE = {};

export function staleEntryProblem(check, entry) {
    if (!/^\d{4}-\d\d-\d\d \S/.test(entry)) return `${check}: a known-stale entry starts with its date and reason`;
    if (!/[\w-]+\.mjs:\d+/.test(entry)) return `${check}: a known-stale entry names the check line that misreads the app (file.mjs:line)`;
    if (!/\bproof \/\S+/.test(entry)) return `${check}: a known-stale entry needs "proof /path" to evidence that the app works`;
    return null;
}

export const staleProblems = (stale = KNOWN_STALE) => Object.entries(stale).map(([check, entry]) => staleEntryProblem(check, entry)).filter(Boolean);

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


export function defaultChecks(names) {
    const found = names.map((n) => n.replace(/\.mjs$/, '')).filter((n) => /^check-[\w-]+-device$|^capture-parity-screens$/.test(n));
    const known = ORDER.filter((n) => found.includes(n) && n !== LAST);
    const fresh = found.filter((n) => !ORDER.includes(n)).sort();
    return [...known, ...fresh, ...(found.includes(LAST) ? [LAST] : [])];
}


export function withAdbPort(env) {
    env.ANDROID_ADB_SERVER_PORT ||= ADB_PORT;
    return env;
}
export const setenvArgs = (env) => ['PATH', 'JAVA_HOME', 'HOME', 'ANDROID_ADB_SERVER_PORT', 'PARITY_ONLY', 'MINDWTR_UPGRADE_ONLY'].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`);


export function unreachable(result, port, total) {
    const state = result.stdout?.trim() || result.stderr?.trim().split('\n').pop() || result.error?.message || `exit ${result.status}`;
    return state === 'device' ? null : `VERDICT FAIL 0/${total}: not run, ${SERIAL} not reachable on adb port ${port} (${state})`;
}

export function staleLines(results, stale = KNOWN_STALE) {
    return results.filter((r) => stale[r.check]).map((r) => r.exit === 0
        ? `KNOWN-STALE PASSED ${r.check}: take it off KNOWN_STALE (${stale[r.check]})`
        : `KNOWN-STALE FAILED ${r.check} EXIT=${r.exit}: ${stale[r.check]}`);
}

export function verdict(results, stale = KNOWN_STALE) {
    const failed = results.filter((r) => r.exit !== 0).map((r) => r.check);
    const fresh = failed.filter((check) => !stale[check]);
    const known = failed.filter((check) => stale[check]);
    const passed = results.length - failed.length;
    const tail = known.length ? `; known-stale failed: ${known.join(' ')}` : '';
    return fresh.length === 0 && results.length > 0
        ? `VERDICT PASS ${passed}/${results.length}${tail}`
        : `VERDICT FAIL ${passed}/${results.length}: ${fresh.join(' ') || 'no checks ran'}${tail}`;
}

export function checkApks(check, source) {
    if (check === 'check-startup-device') return [SEED_APK, BENCHMARK_APK];
    if (check === 'check-onboarding-device') return [SEED_APK];
    if (check === 'check-bgsync-device') return [PLAY_APK, FOSS_APK];
    return source.includes(PLAY_APK) ? [PLAY_APK] : [];
}

export function checkArgs(check, pinnedApks) {
    return [...pinnedApks, ...(check === 'check-projects-device' ? ['--prune-old'] : [])];
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function pinApks(tree, folder, apks) {
    return [...new Set(apks)].map((apk) => {
        const path = join(folder, apk);
        mkdirSync(dirname(path), { recursive: true });
        copyFileSync(join(tree, apkRoot, apk), path);
        return { apk, path, sha: sha256(path) };
    });
}

export function apkDrift(pinned) {
    const changed = pinned.map((p) => ({ ...p, now: sha256(p.path) })).filter((p) => p.now !== p.sha);
    return changed.length ? `STOP: pinned APK changed mid-batch: ${changed.map((p) => `${p.path} ${p.sha} now ${p.now}`).join(', ')}` : null;
}


export function harnessChecks(checks, read) {
    const reads = (check) => read(check).includes('apks/manifest.json');
    return checks.filter((check) => reads(check)
        || [...read(check).matchAll(/'((?:check-[\w-]+-device|capture-parity-screens))\.mjs'/g)].some(([, other]) => other !== check && reads(other)));
}


export function buildSteps(tree, needHarness) {
    return [
        ['bundle', process.execPath, [`${scriptsDir}/build-bundle.mjs`]],
        ['gradle', './gradlew', [':app:assembleDebug', ':app:assembleUpgradetest', ':app:assemblePlayBenchmark', ':app:assemblePlayBenchmarkSeed', '--offline', '-q'],
            { cwd: join(tree, 'apps/android-native/android') }],
        ...(needHarness.length ? [['harness', process.execPath, [`${scriptsDir}/build-upgrade-harness.mjs`]]] : []),
    ];
}

export function resetLibrary(adb, pkg, pastOnboarding) {
    if (!DISPOSABLE_PACKAGES.includes(pkg)) throw new Error(`refusing to clear ${pkg}`);
    if (!adb('pm', 'list', 'packages', pkg).split('\n').some((line) => line.trim() === `package:${pkg}`)) return 'not installed';
    const granted = [...new Set([...adb('dumpsys', 'package', pkg).matchAll(/^\s+(android\.permission\.[\w.]+): granted=true/gm)].map(([, name]) => name))];
    const exactMode = () => /SCHEDULE_EXACT_ALARM: (\w+)/.exec(adb('appops', 'get', pkg, 'SCHEDULE_EXACT_ALARM'))?.[1] ?? 'default';
    const exactBefore = exactMode();
    const cleared = adb('pm', 'clear', pkg);
    for (const permission of granted) adb('pm', 'grant', pkg, permission);
    if (exactMode() !== exactBefore) adb('appops', 'set', pkg, 'SCHEDULE_EXACT_ALARM', exactBefore);
    const onboarding = pkg === DISPOSABLE_PACKAGES[0] ? `, past onboarding=${pastOnboarding()}` : '';
    return `${cleared}, ${granted.length} permissions granted again, exact alarms ${exactBefore} (now ${exactMode()})${onboarding}`;
}

export const closingLines = (results, pastOnboarding, stale = KNOWN_STALE) => [...staleLines(results, stale), `past onboarding=${pastOnboarding()}`, verdict(results, stale)];

const hhmm = () => new Date().toTimeString().slice(0, 5);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

function main() {
    withAdbPort(process.env);
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`run-device-batch: ${error.message}`);
        process.exit(2);
    }
    const badStale = staleProblems();
    if (badStale.length) {
        console.error(`run-device-batch: ${badStale.join('; ')}`);
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
        const env = setenvArgs(process.env);

        const run = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--property=KillMode=process', `--working-directory=${opts.tree}`, ...env,
            `--property=StandardOutput=append:${opts.log}/runner.out`, `--property=StandardError=append:${opts.log}/runner.out`,
            process.execPath, ...self], { stdio: 'inherit' });
        if (run.status === 0) console.log(`unit ${unit}\nlog ${opts.log}\nverdict: tail -1 ${opts.log}/summary.txt`);
        process.exit(run.status ?? 1);
    }


    if (!process.env.S23_LOCKED) {
        const run = spawnSync('flock', ['-o', '-E', String(LOCK_TIMED_OUT), '-w', '43200', LOCK, process.execPath, ...self],
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
    const pastOnboarding = () => run(process.execPath, [`${scriptsDir}/past-onboarding-device.mjs`, SERIAL], 'past-onboarding.log');
    const finish = (results) => {
        adb('settings', 'put', 'system', 'accelerometer_rotation', '1');
        say(`end ${new Date().toString()} rotation=${adb('settings', 'get', 'system', 'accelerometer_rotation')}`);
        const lines = closingLines(results, pastOnboarding);
        for (const line of lines) say(line);
        process.exit(lines.at(-1).startsWith('VERDICT PASS') ? 0 : 1);
    };

    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.tree, encoding: 'utf8' }).stdout.trim();
    say(`start ${new Date().toString()} tree ${opts.tree} head ${head} harness ${opts.harness ?? env.MINDWTR_HARNESS_DIR ?? '(default)'}`);

    const stop = unreachable(spawnSync(ADB, ['-s', SERIAL, 'get-state'], { encoding: 'utf8' }), process.env.ANDROID_ADB_SERVER_PORT, checks.length);
    if (stop) {
        say(stop);
        process.exit(1);
    }
    const readCheck = (check) => readFileSync(join(opts.tree, scriptsDir, `${check}.mjs`), 'utf8');
    const needHarness = harnessChecks(checks, readCheck);
    let harnessFailed = false;
    if (opts.build) {
        if (!needHarness.length) say('harness=skipped (no check needs it)');
        for (const [name, cmd, args, extra] of buildSteps(opts.tree, needHarness)) {
            const code = run(cmd, args, `${name}.log`, extra);
            say(`${name}=${code}`);
            if (code !== 0 && name === 'harness' && needHarness.length < checks.length) {
                say(`harness failed (${opts.log}/harness.log): not run: ${needHarness.join(' ')}`);
                harnessFailed = true;
            } else if (code !== 0) {
                say(`STOP: ${name} failed (${opts.log}/${name}.log)`);
                say(`VERDICT FAIL 0/${checks.length}: not run, ${name} failed`);
                process.exit(1);
            }
        }
    }

    const apksOf = new Map(checks.map((check) => [check, checkApks(check, readCheck(check))]));
    let pinned;
    try {
        pinned = pinApks(opts.tree, join(opts.log, 'apks'), [...apksOf.values()].flat());
    } catch (error) {
        say(`STOP: could not copy the APKs into ${opts.log}/apks: ${error.message}`);
        say(`VERDICT FAIL 0/${checks.length}: not run, APK copy failed`);
        process.exit(1);
    }
    for (const { path, sha } of pinned) say(`apk ${path} sha256 ${sha} head ${head}`);
    const pinnedPath = new Map(pinned.map(({ apk, path }) => [apk, path]));
    for (const pkg of DISPOSABLE_PACKAGES) say(`reset ${pkg}: ${resetLibrary(adb, pkg, pastOnboarding)}`);

    const results = [];
    for (const [index, check] of checks.entries()) {
        const drift = apkDrift(pinned);
        if (drift) {
            say(drift);
            for (const skipped of checks.slice(index)) results.push({ check: skipped, exit: 1 });
            finish(results);
        }
        if (harnessFailed && needHarness.includes(check)) {
            say(`## ${check} ${hhmm()}`);
            say('EXIT=1 not run, harness failed');
            results.push({ check, exit: 1 });
            continue;
        }
        const top = adb('dumpsys', 'activity', 'activities').split('\n').find((l) => l.includes('topResumedActivity')) ?? '';
        const leftOpen = DISPOSABLE_PACKAGES.find((pkg) => top.includes(` ${pkg}/`));
        if (leftOpen) {
            adb('am', 'force-stop', leftOpen);
            say(`force-stopped ${leftOpen}: it was still in front`);
        }
        if (!top.includes('launcher')) adb('input', 'keyevent', 'KEYCODE_HOME');
        adb('settings', 'put', 'system', 'accelerometer_rotation', '1');
        say(`## ${check} ${hhmm()}`);
        const code = run('timeout', ['3600', process.execPath, `${scriptsDir}/${check}.mjs`, SERIAL, ...checkArgs(check, apksOf.get(check).map((apk) => pinnedPath.get(apk)))], `${check}.log`);
        say(`EXIT=${code} rotation=${adb('settings', 'get', 'system', 'accelerometer_rotation')}`);
        results.push({ check, exit: code });
        if (code !== 0) for (const pkg of DISPOSABLE_PACKAGES) say(`reset ${pkg} after the failure: ${resetLibrary(adb, pkg, pastOnboarding)}`);
    }
    finish(results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
