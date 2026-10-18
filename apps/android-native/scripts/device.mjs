// adb helpers shared by the native Android device checks. Every call goes to
// one serial. UI input happens only while `pkg` is in front, and a launch
// happens only from the launcher or `pkg` itself.
// First: wait for the phone (one run per serial; see device-lock.mjs).
import './device-lock.mjs';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export class Stopped extends Error {}

// Core's English (en.ts): the checks expect the phone's language to resolve to English.
const { en } = await import(resolve(import.meta.dirname, '../../../packages/core/src/i18n/locales/en.ts'));
/**
 * The Inbox count as the screen gives it. RN's "Process Inbox (N)" button speaks the exact count (it shows 99+ above
 * 99); an empty Inbox has no button and shows RN's empty message (0). NaN while neither is on screen (a scrolled list).
 */
export const inboxCount = (nodes) => {
    const pattern = new RegExp(`^${en['inbox.processButton']} \\((\\d+)\\)$`);
    const count = nodes.map((node) => pattern.exec(node['content-desc'] ?? '')?.[1]).find(Boolean);
    if (count !== undefined) return Number(count);
    return nodes.some((node) => node.text === en['inbox.empty']) ? 0 : NaN;
};
/** The Inbox list's first item is on screen: RN's scope line ("All areas") sits under the Process Inbox button. */
export const atInboxTop = (nodes) => nodes.some((node) => node.text === en['projects.allAreas']);

// The last connected device, for failure evidence.
let evidenceDevice;
let evidenceWithheld = () => null;
/**
 * A script's rule for a secret: [reason] answers why no evidence may be saved now (a secret on screen), or null. A reason that
 * throws withholds too.
 */
export const withholdEvidenceWhen = (reason) => { evidenceWithheld = reason; };
/**
 * Saves a screenshot and the uiautomator XML of the phone as it is now to
 * /home/dd/.mindwtr-harness/failures/<script>-<timestamp>/ and prints the path.
 * It never throws: evidence must not hide the failure it records.
 */
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
        try { writeFileSync(`${dir}/screen.png`, evidenceDevice.adbRaw('exec-out', 'screencap', '-p')); } catch { /* device gone */ }
        try { writeFileSync(`${dir}/ui.xml`, evidenceDevice.dump()); } catch { /* hierarchy unavailable */ }
        console.error(`failure evidence: ${dir}`);
        return dir;
    } catch {
        return undefined;
    }
};
/** Fails the check: saves evidence first. Scripts' catch blocks save it for any other error (see `evidenced`). */
export const fail = (message) => {
    const error = new Error(message);
    error.evidence = saveEvidence();
    throw error;
};
/** For a script's catch: evidence for a failure that did not come through fail(). */
export const evidenced = (error) => {
    if (!(error instanceof Stopped) && !error?.evidence) saveEvidence();
};
export const check = (condition, message) => { if (!condition) fail(message); console.log(`ok - ${message}`); };
/** True when [dim] is [full] drawn at [alpha] over [under] (#RRGGBB, within 4 a channel): RN's opacity on a disabled button. */
export const blended = (dim, full, under, alpha = 0.5) => {
    const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return dim !== full && rgb(dim).every((value, i) => Math.abs(value - (rgb(full)[i] * alpha + rgb(under)[i] * (1 - alpha))) <= 4);
};

// uiautomator escapes a line break in a node's text as &#10; (the capture popup's several lines).
const decode = (value) => value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const field = (nodes) => nodes.find((node) => node.class === 'android.widget.EditText');
/** A swipe that starts left of this x can be read as the system Back gesture (gesture navigation). */
export const EDGE_SAFE_X = 160;
export const box = (node) => node.bounds.match(/\d+/g).map(Number);
// logcat's threadtime lines start with "MM-DD HH:MM:SS.mmm". The ring buffer drops its oldest lines while a long sync logs,
// so a count of matching lines can stay flat after a new one arrives: count only lines newer than a stamp taken before the act.
const LOG_STAMP = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/;
/** The newest line's stamp in [text] ('' for none). */
export const logStamp = (text) => text.split('\n').reduce((newest, line) => (line.match(LOG_STAMP)?.[0] ?? '') > newest ? line.match(LOG_STAMP)[0] : newest, '');
/** The lines of [text] stamped after [stamp] (all lines when [stamp] is ''). */
export const linesAfter = (text, stamp) => text.split('\n').filter((line) => !stamp || (line.match(LOG_STAMP)?.[0] ?? '') > stamp);
/**
 * The screen's main vertical list: the tallest scrollable node that is not horizontal. A screen can have a second
 * scrollable, as the Weekly Review's row of step chips (a HorizontalScrollView), and the first one found is not always
 * the list (run 38).
 */
export const mainList = (nodes) => nodes.filter((node) => node.scrollable === 'true' && node.class !== 'android.widget.HorizontalScrollView')
    .sort((a, b) => (box(b)[3] - box(b)[1]) - (box(a)[3] - box(a)[1]))[0];
// A Compose button's label is a child node; the enabled state is on the clickable node around it. That node is the
// button's touch area, widened to 48dp but clipped where it would overlap a neighbour's (the editor's Close beside the
// Focus star), so it may not hold the whole label: it holds the label's center.
export const button = (nodes, label) => {
    const labelNode = nodes.find((node) => node.text === label || node['content-desc'] === label);
    if (!labelNode) return undefined;
    const [x1, y1, x2, y2] = box(labelNode);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    return nodes.filter((node) => node.clickable === 'true').filter((node) => {
        const [left, top, right, bottom] = box(node);
        return left <= cx && top <= cy && right >= cx && bottom >= cy;
    }).sort((a, b) => {
        const area = (node) => { const [l, t, r, bt] = box(node); return (r - l) * (bt - t); };
        return area(a) - area(b);
    })[0];
};
/**
 * The tab labelled [name]: the smallest focusable node around a label with that text. A Compose
 * tab is selectable, and the header above the list can show the same word, so only a label
 * inside a focusable node counts.
 */
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
/** The capture field's text, "" when the capture sheet is closed (a saved capture closes it, as in RN). */
export const draftText = (nodes) => field(nodes)?.text ?? '';
export const hasText = (nodes, text) => nodes.some((node) => node.text === text && node.class !== 'android.widget.EditText');
/** The open project's title: RN's editable header field (ProjectDetails.kt's project-title-input) shows it. */
export const projectTitled = (nodes, title) => nodes.some((node) => (node['resource-id'] ?? '').endsWith('project-title-input') && node.text === title);
/** The message of a failed boot: the app then shows only this text, tagged for tests, and no command control. */
export const bootFailure = (nodes) => nodes.find((node) => /(^|\/)boot-failure$/.test(node['resource-id'] ?? ''))?.text;
/**
 * Task rows fully inside the list: each row's title node (test tag `task-row`), whose text is the
 * title and whose `enabled` is the row's edit lock. RN draws no Done button: Done is a swipe
 * right and a TalkBack custom action.
 */
export const taskRows = (nodes) => {
    const list = mainList(nodes);
    const [, top, , bottom] = list ? box(list) : [0, 0, 0, Infinity];
    return nodes.filter((node) => /(^|\/)task-row$/.test(node['resource-id'] ?? '')).filter((node) => {
        const [, t, , b] = box(node);
        // The first row's title line box (RN's full line height) can stand a few px above the list's top while the row
        // shows whole (History › Done: title at 378, list at 381), so the top gets 8 px of slack.
        return t >= top - 8 && b <= bottom;
    });
};
export const taskRow = (nodes, title) => taskRows(nodes).find((node) => node.text === title);
/**
 * The node reading [text] only when it lies fully inside the list. A row scrolled partly
 * under the tab bar still reports bounds there, so tapping its middle can hit the tab bar's
 * center capture button (check-focus-device failure 2026-09-23T18-15-24).
 */
export const inList = (nodes, text) => {
    const list = mainList(nodes);
    const [, top, , bottom] = list ? box(list) : [0, 0, 0, Infinity];
    return nodes.find((node) => node.text === text && node.class !== 'android.widget.EditText' && box(node)[1] >= top && box(node)[3] <= bottom);
};
/** The task editor is open: its root carries the test tag `task-editor` (RN's editor has no title to find it by). */
export const inEditor = (nodes) => nodes.some((node) => /(^|\/)task-editor$/.test(node['resource-id'] ?? ''));
/**
 * The failure message's Try again while a command's retry is owed: it re-sends that exact command (test tag
 * `owed-retry`). The read refresh (`read-retry`) is offered only when no retry is owed.
 */
export const owedRetry = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === 'owed-retry');
export const readRetry = (nodes) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === 'read-retry');
/** The node tagged [tag] (a Compose test tag, exposed as the resource id). */
export const tagged = (nodes, tag) => nodes.find((node) => (node['resource-id'] ?? '').split('/').pop() === tag);
/** A choice chip is on: selected (one-of-many chips are selectable, as RN's). */
// A Compose chip or selectable reports its state as `selected` or, on this phone, as `checked` (Contexts chips, run 36).
export const isOn = (node) => node?.selected === 'true' || node?.checked === 'true';
/** The value an editor control announces as "<label>: <value>", as RN's accessibility labels do (Status, Destination, Due Date). */
export const described = (nodes, label) => nodes.find((node) => node['content-desc']?.startsWith(`${label}: `))?.['content-desc'].slice(label.length + 2);
/** The node whose TalkBack text is exactly [description]. */
export const withDescription = (nodes, description) => nodes.find((node) => node['content-desc'] === description);
/**
 * Whether the choice chip described [description] is on. A selected Compose `selectable` node reports
 * `selected="true"` but `clickable="false"`, so look at the smallest focusable node around the label.
 */
export const chipOn = (nodes, description) => {
    const label = withDescription(nodes, description);
    if (!label) return false;
    if (isOn(label)) return true;
    const [x1, y1, x2, y2] = box(label);
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const area = (node) => { const [l, t, r, b] = box(node); return (r - l) * (b - t); };
    // The selectable's reported box can stop a few pixels short of its label (run 25: 1569-1671 around
    // 1602-1680), so match the smallest focusable node that holds the label's center.
    const around = nodes.filter((node) => node.focusable === 'true').filter((node) => {
        const [l, t, r, b] = box(node);
        return l <= cx && cx <= r && t <= cy && cy <= b;
    }).sort((a, b) => area(a) - area(b))[0];
    return isOn(around);
};
/**
 * Whether the switch labelled [description] is on. On this phone a Compose switch is a plain View: the checkable
 * node is the parent, and the labelled child always says checked="false" (run 29), so read the smallest checkable
 * node that holds the label's center.
 */
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
/** The control labelled [label] on the same line as the row titled [title] (RN's star sits beside the title). */
export const besideRow = (nodes, title, label) => {
    const row = nodes.find((node) => node.text === title && node.class !== 'android.widget.EditText');
    if (!row) return undefined;
    const [, t, , b] = box(row);
    const middle = (t + b) / 2;
    return nodes.find((node) => node['content-desc'] === label && box(node)[1] <= middle && box(node)[3] >= middle);
};

export function connect({ serial, pkg, uiFile, adb = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb' }) {
    const adbRaw = (...args) => execFileSync(adb, ['-s', serial, ...args], { maxBuffer: 64 << 20 });
    const shell = (command) => adbRaw('shell', command).toString('utf8').replace(/\r/g, '').trim();
    /**
     * The checks type digits through the phone's own keyboard. A Chinese Pinyin (or any non-Latin) layout holds or
     * reorders typed characters (run 22: "…457896" arrived as "…457869"), so every typing command first reads the
     * current keyboard layout. When it is not English, the check SWITCHES it to an English layout the keyboard
     * already has enabled (`settings put secure selected_input_method_subtype <hash>`, the same setting the globe
     * key changes; dd 2026-09-24: "you can switch the keyboard"), checks the switch took, and puts the original
     * layout back when the check's process exits. It stops (exit 3) only when no enabled English layout exists or
     * the switch does not take. The layout is read from `dumpsys input_method`: the current subtype line
     * (mCurrentSubtype / mCurSubtype), or the subtype that `selected_input_method_subtype` names in the IME's
     * subtype list. MINDWTR_KEYBOARD_OK=1 skips the guard after a person has looked at the keyboard.
     */
    const readKeyboardLanguage = () => {
        const dump = shell('dumpsys input_method');
        const language = (text) => /(?:languageTag|mSubtypeLanguageTag|locale|mSubtypeLocale)=\s*"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)/.exec(text)?.[1];
        const current = dump.split('\n').filter((line) => /mCur(rent)?Subtype\b/.test(line)).join(' ');
        let tag = language(current);
        let source = current.trim();
        if (!tag) {
            const hash = shell('settings get secure selected_input_method_subtype').trim();
            if (/^-?\d+$/.test(hash)) {
                // The IME's subtype list prints each subtype on one line ending in its hash code, for example
                // `... mSubtypeLocale=zh_CN mSubtypeLanguageTag=zh-CN ... mSubtypeHashCode=617035939`
                // (Gboard on this phone); take the line that carries this one.
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
        // Switch to an English layout the current keyboard already has enabled (en_US first).
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
                try { shell(`settings put secure selected_input_method_subtype ${originalKeyboardSubtype}`); } catch { /* the phone is gone */ }
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
    /**
     * The uiautomator XML of the screen now. [uiFile] `/dev/tty` streams it to adb and never writes it on the phone (a screen
     * that can show a secret); any other path is written there, then read.
     */
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
    const launch = (activity) => {
        requireEnglishKeyboard();
        const current = front();
        if (!current.includes(`${pkg}/`) && !current.includes(`${home}/`)) {
            throw new Stopped(`another app is in front; not launching over it: ${current.trim()}`);
        }
        sh(`am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${activity}`);
    };
    /**
     * The app's process id. Two processes can carry the package's name at once: one still exiting, or one
     * the system started on its own (for example right after a package replace). The newest one is the
     * process the last launch created; the others are printed once, with their start and parent, as evidence.
     */
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
    /**
     * Force-stops the app until its process stays gone. Right after `install -r` the launcher's placed widgets get their
     * update broadcast (TasksWidgetProvider), and SystemUI rebinds a placed Quick Settings tile 5 s after its process died:
     * either starts the app again just after one force-stop (S23 10-05: "timed out waiting for the app process to end").
     */
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
            } catch { /* the hierarchy is briefly unavailable during recreation */ }
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
        // A node scrolled out of view can still be listed with empty bounds; tapping its "middle" would hit the
        // status bar (run 22: the Status chips below the filter sheet's fold reported [0,0][0,0]).
        if (x2 <= x1 || y2 <= y1) fail(`not on screen (empty bounds ${node.bounds}): ${node.text || node['content-desc'] || node['resource-id']}`);
        sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
        await sleep(400);
    };
    /** Everything a tap can change on screen: texts, labels, places, and each control's enabled and on state. */
    const state = (nodes) => nodes.map((node) => `${node.text}|${node['content-desc']}|${node.bounds}|${node.enabled}|${node.selected}|${node.checked}`).join('\n');
    /**
     * Taps [node] and waits for [expected]. A heads-up notification can sit over a control and take the tap.
     * The tap is repeated once, and only when it provably did nothing: after 4 s the app is still in front and
     * its screen is exactly as before the tap (no busy state, no disabled control, nothing moved). The retry
     * waits 5 s first, so the notification can leave. A tap that changed anything is never repeated.
     */
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
    /**
     * Focuses the text field [node] with its cursor at the text's true end, ready for typing. A tap lands at the
     * field's far end (a tap in the middle of a long value puts the cursor inside the text), the check waits for the
     * keyboard so the tap's cursor placement is done, and then Ctrl+End moves to the true end (past trailing
     * whitespace, and past line ends in a wrapped value). Run 23: with the tap in the middle and Ctrl+End sent
     * before the tap's cursor landed, the typed "6" went in before the title's last "9".
     */
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
    /** Swipes the app's list one step: 'up' scrolls toward the top. A list that fits is not scrollable: same hierarchy. */
    const swipe = async (nodes, direction) => {
        const list = mainList(nodes);
        if (!list) return nodes;
        requireAppFront();
        const [x1, y1, x2, y2] = box(list);
        const [low, high] = [Math.round(y2 - (y2 - y1) * 0.15), Math.round(y1 + (y2 - y1) * 0.15)];
        // A moderate drag: a fast one flings past rows on a short (landscape) list. The first drag is at the middle;
        // a drag that moved nothing is tried once more further right (never in the screen-edge gesture zones), so
        // one gesture the system or a still-settling list ignored is never read as the end of the list.
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
    /**
     * Scrolls the app's list until [find] picks a node inside it (its centre below the list's top, its bottom 40 px clear of
     * the list's bottom): from the top unless [fromTop] is false, then down. The centre, not the top, because a clickable
     * row title's 48 dp touch area reaches above its card: the list's first row sticks out over the list's top edge. A node
     * already partly on screen comes in with one short, slow drag to the list's middle: a full swipe flings past a field
     * just under the fold (Sync's Username, once settings rows grew to RN's height).
     */
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
    /** Scrolls the list to its first item (the Inbox's Process button is a list item). */
    const toTop = async () => {
        let nodes = await screen();
        for (let step = 0; step < 60; step += 1) {
            const next = await swipe(nodes, 'up');
            if (signature(next) === signature(nodes)) return next;
            nodes = next;
        }
        return nodes;
    };
    /** Waits until the screen holds still (two equal dumps, at most 3 s): a sheet sliding with the keyboard moves its controls. */
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
    /** Opens RN's quick capture sheet from the center tab button (core's `nav.addTask`), unless a field already shows. */
    const openCapture = async () => {
        let nodes = await screen();
        if (field(nodes)) return nodes;
        // The Process Inbox button (the count) is the list's first item: start from the top so the
        // capture's new count is on screen when it lands. At the top already, this is one drag.
        if (!atInboxTop(nodes)) nodes = await toTop();
        // The tap waits until the screen holds still (two equal dumps), and it is a tapExpecting: run 24's plain tap
        // on + was lost (10 s later the Inbox was unchanged, + enabled, nothing over it), and a plain tap is never
        // repeated. tapExpecting repeats it once, and only when the first provably changed nothing.
        nodes = await settle(nodes);
        nodes = await tapExpecting(button(nodes, 'Add Task') ?? fail('no Add Task button on screen'), (current) => Boolean(field(current)), 'the capture sheet', 10_000);
        // Add another is a remembered preference (as in RN). A run that stopped with it on left every later
        // capture open (run 30), so each check starts with it off.
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
    /**
     * Scrolls the app's list until a row reading [text] lies fully inside it (see inList): back to the
     * top first (an earlier step may have left the list scrolled past the row), then forward.
     */
    const reveal = async (text, swipes = 150) => {
        let nodes = await screen();
        for (const towardTop of [true, false]) {
            for (let step = 0; step < swipes && !inList(nodes, text); step += 1) {
                let next = await swipe(nodes, towardTop ? 'up' : 'down');
                if (signature(next) === signature(nodes)) {
                    // At the bottom of a paged list: load the next window (core's `common.more`) and keep going.
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
    /**
     * RN's swipe: dragging the row titled [title] right reveals its labelled action button (test tag `swipe-action`),
     * which is returned. Nothing runs until the button is tapped (RN's swipeable-task-item).
     */
    const revealAction = async (nodes, title) => {
        const row = taskRow(nodes, title) ?? fail(`no row ${title} on screen`);
        requireAppFront();
        const [x1, y1, , y2] = box(row);
        const y = Math.round((y1 + y2) / 2);
        // Start clear of the screen edge: Android's gesture navigation takes a swipe from the edge as Back (run 29).
        const from = Math.max(x1 + 10, EDGE_SAFE_X);
        sh(`input swipe ${from} ${y} ${from + 440} ${y} 400`);
        const beside = (current) => current.find((node) => (node['resource-id'] ?? '').endsWith('swipe-action') && box(node)[1] <= y && box(node)[3] >= y);
        return beside(await waitFor(`the action button beside ${title}`, (current) => Boolean(beside(current)), 8_000));
    };
    /** Reveals the row's action button and taps it: RN's swipe action, Done in this app. */
    const swipeDone = async (nodes, title) => {
        const action = await revealAction(nodes, title);
        requireAppFront();
        const [l, t, r, b] = box(action);
        sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
        await sleep(600);
    };
    /** Swipes [title] to Done until [done] holds; a swipe can land while the list still moves, so swipe again. */
    const completeUntil = async (title, description, done) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const nodes = await screen();
            // The last swipe took effect after the wait ran out: another would be a second command.
            if (attempt > 0 && done(nodes)) return nodes;
            if (!taskRow(nodes, title) && attempt > 0) break;
            await swipeDone(nodes, title);
            try { return await waitFor(description, done, 8_000); } catch { /* swipe again */ }
        }
        return waitFor(description, done, 20_000);
    };
    /** Exact bytes of one app-private file (run-as, so the app must be debuggable). */
    // Streamed into the file: a large library's database or write-ahead log passes any output buffer (D1c step 0: ENOBUFS).
    const pull = (remote, local) => {
        const out = openSync(local, 'w');
        try { execFileSync(adb, ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', remote], { stdio: ['ignore', out, 'pipe'] }); }
        finally { closeSync(out); }
    };
    /** A screenshot saved to [file], and its #RRGGBB at each [x, y]. */
    const colors = (file, points) => {
        writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
        return execFileSync('magick', [file, '-format', points.map(([x, y]) => `%[hex:p{${x},${y}}]`).join(' '), 'info:'], { encoding: 'utf8' })
            .trim().split(' ').map((hex) => hex.slice(0, 6).toUpperCase());
    };
    return { adbRaw, sh, home, front, requireAppFront, launch, pid, stopApp, tapExpecting, focusAtEnd, logs, screen, waitFor, tap, openCapture, type, swipe, signature, toTop, settle, reveal, revealNode, pull, colors, revealAction, swipeDone, completeUntil };
}
