


import './device-lock.mjs';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export class Stopped extends Error {}


const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));


export const inboxCount = (nodes) => {
    const pattern = new RegExp(`^${en['inbox.processButton']} \\((\\d+)\\)$`);
    const count = nodes.map((node) => pattern.exec(node['content-desc'] ?? '')?.[1]).find(Boolean);
    if (count !== undefined) return Number(count);
    return nodes.some((node) => node.text === en['inbox.empty']) ? 0 : NaN;
};

export const atInboxTop = (nodes) => nodes.some((node) => node.text === en['projects.allAreas']);


let evidenceDevice;
let evidenceWithheld = () => null;


export const withholdEvidenceWhen = (reason) => { evidenceWithheld = reason; };


export const saveEvidence = () => {
    if (!evidenceDevice) return undefined;
    let withheld;
    try { withheld = evidenceWithheld(); } catch { withheld = 'the secret check failed'; }
    if (withheld) {
        console.error(`failure evidence withheld: ${withheld}`);
        return undefined;
    }
    const script = basename(process.argv[1] ?? 'device', '.mjs');
    const dir = `/home/dd/.mindwtr-harness/failures/${script}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        mkdirSync(dir, { recursive: true });
        try { writeFileSync(`${dir}/screen.png`, evidenceDevice.adbRaw('exec-out', 'screencap', '-p')); } catch {                   }
        try { writeFileSync(`${dir}/ui.xml`, evidenceDevice.dump()); } catch {                             }
        console.error(`failure evidence: ${dir}`);
        return dir;
    } catch {
        return undefined;
    }
};

export const fail = (message) => {
    const error = new Error(message);
    error.evidence = saveEvidence();
    throw error;
};

export const evidenced = (error) => {
    if (!(error instanceof Stopped) && !error?.evidence) saveEvidence();
};
export const check = (condition, message) => { if (!condition) fail(message); console.log(`ok - ${message}`); };

export const blended = (dim, full, under, alpha = 0.5) => {
    const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return dim !== full && rgb(dim).every((value, i) => Math.abs(value - (rgb(full)[i] * alpha + rgb(under)[i] * (1 - alpha))) <= 4);
};


const decode = (value) => value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const field = (nodes) => nodes.find((node) => node.class === 'android.widget.EditText');

export const EDGE_SAFE_X = 160;
export const box = (node) => node.bounds.match(/\d+/g).map(Number);


const LOG_STAMP = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/;

export const logStamp = (text) => text.split('\n').reduce((newest, line) => (line.match(LOG_STAMP)?.[0] ?? '') > newest ? line.match(LOG_STAMP)[0] : newest, '');

export const linesAfter = (text, stamp) => text.split('\n').filter((line) => !stamp || (line.match(LOG_STAMP)?.[0] ?? '') > stamp);


export const mainList = (nodes) => nodes.filter((node) => node.scrollable === 'true' && node.class !== 'android.widget.HorizontalScrollView')
    .sort((a, b) => (box(b)[3] - box(b)[1]) - (box(a)[3] - box(a)[1]))[0];


export const button = (nodes, label) => {
    const labelNode = nodes.find((node) => node.text === label || node['content-desc'] === label);
    if (!labelNode) return undefined;
    const [x1, y1, x2, y2] = box(labelNode);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const around = nodes.filter((node) => node.clickable === 'true').filter((node) => {
        const [left, top, right, bottom] = box(node);
        return left <= cx && top <= cy && right >= cx && bottom >= cy;
    });


    const whole = around.filter((node) => { const [l, t, r, b] = box(node); return l <= x1 && t <= y1 && r >= x2 && b >= y2; });
    return (whole.length ? whole : around).sort((a, b) => {
        const area = (node) => { const [l, t, r, bt] = box(node); return (r - l) * (bt - t); };
        return area(a) - area(b);
    })[0];
};


export const tab = (nodes, name) => {
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };
    for (const label of nodes.filter((node) => node.text === name && node.class === 'android.widget.TextView')) {
        const [x1, y1, x2, y2] = box(label);
        const found = nodes.filter((node) => node.focusable === 'true').filter((node) => {
            const [l, t, r, b] = box(node);
            return l <= x1 && t <= y1 && r >= x2 && b >= y2;
        }).sort((a, b) => area(a) - area(b))[0];
        if (found) return found;
    }
    return undefined;
};
export const tabSelected = (nodes, name) => tab(nodes, name)?.selected === 'true';

export const draftText = (nodes) => field(nodes)?.text ?? '';
export const hasText = (nodes, text) => nodes.some((node) => node.text === text && node.class !== 'android.widget.EditText');

export const projectTitled = (nodes, title) => nodes.some((node) => (node['resource-id'] ?? '').endsWith('project-title-input') && node.text === title);

export const bootFailure = (nodes) => nodes.find((node) => /(^|\/)boot-failure$/.test(node['resource-id'] ?? ''))?.text;


export const taskRows = (nodes) => {
    const list = mainList(nodes);
    const [, top, , bottom] = list ? box(list) : [0, 0, 0, Infinity];
    return nodes.filter((node) => /(^|\/)task-row$/.test(node['resource-id'] ?? '')).filter((node) => {
        const [, t, , b] = box(node);


        return t >= top - 8 && b <= bottom;
    });
};
export const taskRow = (nodes, title) => taskRows(nodes).find((node) => node.text === title);


export const inList = (nodes, text) => {
    const list = mainList(nodes);
    const [, top, , bottom] = list ? box(list) : [0, 0, 0, Infinity];
    return nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText' && box(node)[1] >= top && box(node)[3] <= bottom);
};

export const inEditor = (nodes) => nodes.some((node) => /(^|\/)task-editor$/.test(node['resource-id'] ?? ''));


export const owedRetry = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === 'owed-retry');
export const readRetry = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === 'read-retry');

export const tagged = (nodes, tag) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === tag);


export const isOn = (node) => node?.selected === 'true' || node?.checked === 'true';

export const described = (nodes, label) => nodes.find((node) => node['content-desc']?.startsWith(`${label}: `))?.['content-desc'].slice(label.length + 2);

export const withDescription = (nodes, description) => nodes.find((node) => node['content-desc'] === description);


export const chipOn = (nodes, description) => {
    const label = withDescription(nodes, description);
    if (!label) return false;
    if (isOn(label)) return true;
    const [x1, y1, x2, y2] = box(label);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };


    const around = nodes.filter((node) => node.focusable === 'true').filter((node) => {
        const [l, t, r, b] = box(node);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    }).sort((a, b) => area(a) - area(b))[0];
    return isOn(around);
};


export const switchOn = (nodes, description) => {
    const label = withDescription(nodes, description);
    if (!label) return false;
    const [x1, y1, x2, y2] = box(label);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };
    return nodes.filter((node) => node.checkable === 'true').filter((node) => {
        const [l, t, r, b] = box(node);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    }).sort((a, b) => area(a) - area(b))[0]?.checked === 'true';
};

export const besideRow = (nodes, title, label) => {
    const row = nodes.find((node) => node.text === title && node.class !== 'android.widget.EditText');
    if (!row) return undefined;
    const [, t, , b] = box(row);
    const middle = (t + b) / 2;
    return nodes.find((node) => node['content-desc'] === label && box(node)[1] <= middle && box(node)[3] >= middle);
};


export const DEFAULT_ADB = '/opt/android-sdk/platform-tools/adb';

export function connect({ serial, pkg, uiFile, adb = process.env.ADB ?? DEFAULT_ADB }) {
    process.env.ANDROID_ADB_SERVER_PORT ||= '5038';
    const adbRaw = (...args) => execFileSync(adb, ['-s', serial, ...args], { maxBuffer: 64 << 20 });
    const shell = (command) => adbRaw('shell', command).toString('utf8').replace(/\r/g, '').trim();


    const readKeyboardLanguage = () => {
        const dump = shell('dumpsys input_method');
        const language = (text) => /(?:languageTag|mSubtypeLanguageTag|locale|mSubtypeLocale)=\s*"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)/.exec(text)?.[1];
        const current = dump.split('\n').filter((line) => /mCur(rent)?Subtype\b/.test(line)).join(' ');
        let tag = language(current);
        let source = current.trim();
        if (!tag) {
            const hash = shell('settings get secure selected_input_method_subtype').trim();
            if (/^-?\d+$/.test(hash)) {


                const entry = dump.split('\n').find((line) => new RegExp(`\\bmSubtypeHashCode=${hash}\\b`).test(line) && language(line));
                tag = entry ? language(entry) : undefined;
                source = entry ? entry.trim().split('\n')[0] : `subtype ${hash}`;
            }
        }
        return { tag, source, dump, language };
    };
    const isEnglish = (tag) => Boolean(tag) && /^en(?:[-_]|$)/i.test(tag);
    let originalKeyboardSubtype = null;
    const requireEnglishKeyboard = () => {
        if (process.env.MINDWTR_KEYBOARD_OK === '1') return;
        const { tag, source, dump, language } = readKeyboardLanguage();
        if (isEnglish(tag)) return;

        const ime = shell('settings get secure default_input_method').trim();
        const enabled = shell('settings get secure enabled_input_methods').split(':')
            .map((entry) => entry.split(';')).find(([name]) => name === ime)?.slice(1) ?? [];
        const localeOf = (hash) => {
            const line = dump.split('\n').find((text) => new RegExp(`\\bmSubtypeHashCode=${hash}\\b`).test(text) && language(text));
            return line ? language(line) : undefined;
        };
        const english = enabled.filter((hash) => isEnglish(localeOf(hash)))
            .sort((a, b) => Number(!/^en[-_]US$/i.test(localeOf(a))) - Number(!/^en[-_]US$/i.test(localeOf(b))))[0];
        if (!english) {
            throw new Stopped(`Keyboard is in ${tag ?? `an unknown language (${source || 'no current subtype'})`} and has no English layout enabled; `
                + 'add one or switch with the globe key, then rerun');
        }
        const before = shell('settings get secure selected_input_method_subtype').trim();
        if (originalKeyboardSubtype === null && /^-?\d+$/.test(before)) {
            originalKeyboardSubtype = before;
            process.on('exit', () => {
                try { shell(`settings put secure selected_input_method_subtype ${originalKeyboardSubtype}`); } catch {                         }
            });
        }
        shell(`settings put secure selected_input_method_subtype ${english}`);
        const after = readKeyboardLanguage().tag;
        if (!isEnglish(after)) {
            throw new Stopped(`Keyboard is in ${after ?? tag}; switching it to English (subtype ${english}) did not take; switch with the globe key, then rerun`);
        }
        console.log(`info - keyboard switched from ${tag ?? 'unknown'} to ${after} for typing; restored when this check exits`);
    };
    const sh = (command) => {
        if (/^input text\b/.test(command)) requireEnglishKeyboard();
        return shell(command);
    };


    const dump = () => {
        if (uiFile === '/dev/tty') return adbRaw('exec-out', 'uiautomator', 'dump', '/dev/tty');
        sh(`uiautomator dump ${uiFile}`);
        return adbRaw('exec-out', 'cat', uiFile);
    };
    evidenceDevice = { adbRaw, sh, dump };
    const home = sh('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME')
        .split('\n').pop().split('/')[0];
    const front = () => sh('dumpsys activity activities').split('\n')
        .find((line) => /topResumedActivity|mResumedActivity/.test(line)) ?? '';
    const requireAppFront = () => {
        if (!front().includes(`${pkg}/`)) throw new Stopped(`${pkg} is not in front: ${front().trim()}`);
    };


    const launch = (activity, { startTab = 'inbox' } = {}) => {
        requireEnglishKeyboard();
        const current = front();
        if (!current.includes(`${pkg}/`) && !current.includes(`${home}/`)) {
            throw new Stopped(`another app is in front; not launching over it: ${current.trim()}`);
        }
        sh(`setprop debug.mindwtr.native.start_tab '${startTab}'`);
        sh(`am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`);
    };


    const noted = new Set();
    const pid = () => {
        let all;
        try { all = sh(`pidof ${pkg}`).split(/\s+/).filter(Boolean); } catch { return ''; }
        if (all.length <= 1) return all[0] ?? '';
        const started = (id) => { try { return Number(sh(`cat /proc/${id}/stat`).split(') ').pop().split(' ')[19]); } catch { return -1; } };
        const newest = all.sort((a, b) => started(b) - started(a))[0];
        const key = all.join(' ');
        if (!noted.has(key)) {
            noted.add(key);
            console.log(`note - ${all.length} processes named ${pkg} (${key}); using the newest, ${newest}:\n${sh(`ps -A -o PID,PPID,STIME,STAT,NAME | grep -E '^ *(PID|${all.join('|')}) '`)}`);
        }
        return newest;
    };


    const stopApp = async (timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        let goneSince = 0;
        while (Date.now() < deadline) {
            if (pid()) { sh(`am force-stop ${pkg}`); goneSince = 0; } else if (!goneSince) goneSince = Date.now();
            else if (Date.now() - goneSince >= 2_000) return;
            await sleep(250);
        }
        fail('timed out waiting for the app process to end');
    };
    const logs = (processId, tag) => adbRaw('logcat', '-d', `--pid=${processId}`, '-s', `${tag}:*`).toString('utf8');
    const screen = async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                const xml = dump().toString('utf8');
                if (xml.includes('<hierarchy')) {
                    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => Object.fromEntries(
                        [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]),
                    ));
                }
            } catch {                                                              }
            await sleep(500);
        }
        return fail('uiautomator dump failed');
    };
    const waitFor = async (description, predicate, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const nodes = await screen();
            if (predicate(nodes)) return nodes;
            await sleep(500);
        }
        return fail(`timed out waiting for ${description}`);
    };
    const tap = async (node) => {
        requireAppFront();
        const [x1, y1, x2, y2] = box(node);


        if (x2 <= x1 || y2 <= y1) fail(`not on screen (empty bounds ${node.bounds}): ${node.text || node['content-desc'] || node['resource-id']}`);
        sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
        await sleep(400);
    };

    const state = (nodes) => nodes.map((node) => `${node.text}|${node['content-desc']}|${node.bounds}|${node.enabled}|${node.selected}|${node.checked}`).join('\n');


    const tapExpecting = async (node, expected, description, timeoutMs = 30_000) => {
        const before = state(await screen());
        await tap(node);
        const deadline = Date.now() + 4_000;
        let nodes = await screen();
        while (!expected(nodes) && Date.now() < deadline) { await sleep(500); nodes = await screen(); }
        if (!expected(nodes) && state(nodes) === before) {
            console.log(`note - the tap for ${description} changed nothing (a notification over the control?); tapping again once`);
            await sleep(5_000);
            nodes = await screen();
            if (!expected(nodes) && state(nodes) === before) await tap(node);
        }
        return waitFor(description, expected, timeoutMs);
    };


    const focusAtEnd = async (node) => {
        if (node.focused !== 'true') {
            requireAppFront();
            const [x1, y1, x2, y2] = box(node);
            if (x2 <= x1 || y2 <= y1) fail(`not on screen (empty bounds ${node.bounds}): ${node.text || node['content-desc']}`);
            sh(`input tap ${Math.max(x1 + 1, x2 - 24)} ${Math.round((y1 + y2) / 2)}`);
            for (let wait = 0; wait < 15 && !/mInputShown=true/.test(sh('dumpsys input_method')); wait += 1) await sleep(200);
            await sleep(300);
        }
        requireAppFront();
        sh('input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END');
        await sleep(200);
    };

    const swipe = async (nodes, direction) => {
        const list = mainList(nodes);
        if (!list) return nodes;
        requireAppFront();
        const [x1, y1, x2, y2] = box(list);
        const [low, high] = [Math.round(y2 - (y2 - y1) * 0.15), Math.round(y1 + (y2 - y1) * 0.15)];


        const drag = async (x) => {
            sh(`input swipe ${x} ${direction === 'up' ? high : low} ${x} ${direction === 'up' ? low : high} 500`);
            await sleep(400);
            return screen();
        };
        const moved = await drag(Math.round((x1 + x2) / 2));
        if (signature(moved) !== signature(nodes)) return moved;
        await sleep(600);
        requireAppFront();
        return drag(Math.round(x1 + (x2 - x1) * 0.8));
    };
    const signature = (nodes) => nodes.map((node) => `${node.text}|${node['content-desc']}|${node.bounds}`).join('\n');


    const revealNode = async (find, description, fromTop = true) => {
        let nodes = fromTop ? await toTop() : await screen();
        const inView = (current) => {
            const node = find(current);
            const list = mainList(current);
            return node && (!list || ((box(node)[1] + box(node)[3]) / 2 >= box(list)[1] && box(node)[3] <= box(list)[3] - 40)) ? node : null;
        };
        for (let step = 0; step < 20 && !inView(nodes); step += 1) {
            const partly = find(nodes);
            const list = mainList(nodes);
            if (!partly || !list) {
                nodes = await swipe(nodes, 'down');
                continue;
            }
            const [x1, y1, x2, y2] = box(list);
            const [, top, , bottom] = box(partly);
            const middle = Math.round((y1 + y2) / 2);
            const to = Math.min(y2 - 20, Math.max(y1 + 20, middle - Math.round((top + bottom) / 2 - middle)));
            requireAppFront();
            sh(`input swipe ${Math.round((x1 + x2) / 2)} ${middle} ${Math.round((x1 + x2) / 2)} ${to} 1500`);
            await sleep(500);
            nodes = await screen();
        }
        return inView(nodes) ?? fail(`no ${description} on screen`);
    };


    const flingUp = async (nodes) => {
        const list = mainList(nodes);
        if (!list) return nodes;
        const [x1, y1, x2, y2] = box(list);
        const from = Math.round(y1 + (y2 - y1) * 0.3);
        const stroke = async (x) => {
            requireAppFront();
            sh(`input swipe ${x} ${from} ${x} ${from + 300} 40`);
            await sleep(700);
            return screen();
        };
        const moved = await stroke(Math.round((x1 + x2) / 2));
        if (signature(moved) !== signature(nodes)) return moved;

        await sleep(600);
        return stroke(Math.round(x1 + (x2 - x1) * 0.8));
    };


    const toTop = async () => {
        let nodes = await screen();
        for (let step = 0; step < 60; step += 1) {
            const next = await flingUp(nodes);
            if (signature(next) === signature(nodes)) return next;
            nodes = next;
        }
        return nodes;
    };

    const settle = async (nodes) => {
        nodes = nodes ?? await screen();
        for (let wait = 0; wait < 10; wait += 1) {
            await sleep(300);
            const again = await screen();
            if (signature(again) === signature(nodes)) break;
            nodes = again;
        }
        return nodes;
    };

    const openCapture = async () => {
        let nodes = await screen();
        if (field(nodes)) return nodes;


        if (!atInboxTop(nodes)) nodes = await toTop();


        nodes = await settle(nodes);
        nodes = await tapExpecting(button(nodes, 'Add Task') ?? fail('no Add Task button on screen'), (current) => Boolean(field(current)), 'the capture sheet', 10_000);


        if (switchOn(nodes, 'Add another')) {
            nodes = await tapExpecting(withDescription(nodes, 'Add another'), (current) => !switchOn(current, 'Add another'), 'Add another off');
        }
        return nodes;
    };
    const type = async (title) => {
        const nodes = await openCapture();
        await tap(field(nodes) ?? fail('no text field on screen'));
        requireAppFront();
        sh(`input text ${title}`);
        await waitFor(`the draft ${title} in the field`, (nodes) => field(nodes)?.text === title, 10_000);
    };


    const reveal = async (text, swipes = 150) => {
        let nodes = await screen();
        for (const towardTop of [true, false]) {
            for (let step = 0; step < swipes && !inList(nodes, text); step += 1) {
                let next = await swipe(nodes, towardTop ? 'up' : 'down');
                if (signature(next) === signature(nodes)) {

                    const more = towardTop ? undefined : button(next, 'More');
                    if (!more || more.enabled !== 'true') break;
                    requireAppFront();
                    const [l, t, r, b] = box(more);
                    sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
                    await sleep(1500);
                    next = await screen();
                }
                nodes = next;
            }
            if (inList(nodes, text)) break;
        }
        return nodes;
    };


    const revealAction = async (nodes, title, id = 'done') => {
        const row = taskRow(nodes, title) ?? fail(`no row ${title} on screen`);
        requireAppFront();
        const [x1, y1, x2, y2] = box(row);
        const y = Math.round((y1 + y2) / 2);

        if (['organize', 'dates', 'delete'].includes(id)) {
            const from = Math.min(x2 - 10, x1 + x2 - EDGE_SAFE_X);
            sh(`input swipe ${from} ${y} ${from - 440} ${y} 400`);
        } else {
            const from = Math.max(x1 + 10, EDGE_SAFE_X);
            sh(`input swipe ${from} ${y} ${from + 440} ${y} 400`);
        }
        const beside = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith(`swipe-${id}`) && box(node)[1] <= y && box(node)[3] >= y);
        return beside(await waitFor(`the ${id} button beside ${title}`, (current) => Boolean(beside(current)), 8_000));
    };

    const swipeDone = async (nodes, title) => {
        const action = await revealAction(nodes, title);
        requireAppFront();
        const [l, t, r, b] = box(action);
        sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
        await sleep(600);
    };

    const completeUntil = async (title, description, done) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const nodes = await screen();

            if (attempt > 0 && done(nodes)) return nodes;
            if (!taskRow(nodes, title) && attempt > 0) break;
            await swipeDone(nodes, title);
            try { return await waitFor(description, done, 8_000); } catch {                   }
        }
        return waitFor(description, done, 20_000);
    };


    const pull = (remote, local) => {
        const out = openSync(local, 'w');
        try { execFileSync(adb, ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', remote], { stdio: ['ignore', out, 'pipe'] }); }
        finally { closeSync(out); }
    };

    const colors = (file, points) => {
        writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
        return execFileSync('magick', [file, '-format', points.map(([x, y]) => `%[hex:p{${x},${y}}]`).join(' '), 'info:'], { encoding: 'utf8' })
            .trim().split(' ').map((hex) => hex.slice(0, 6).toUpperCase());
    };
    return { adbRaw, sh, home, front, requireAppFront, launch, pid, stopApp, tapExpecting, focusAtEnd, logs, screen, waitFor, tap, openCapture, type, swipe, signature, toTop, settle, reveal, revealNode, pull, colors, revealAction, swipeDone, completeUntil };
}
