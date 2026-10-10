// The Android bundle's MindwtrHost table: the methods of host-entry.ts that Android calls, and no others.
//
// host-entry.ts holds every host method once, for both platforms. iOS bundles it as written
// (apps/ios-native/scripts/build-bundle.mjs). Android's build-bundle.mjs first drops every method not named below, so an
// Android start neither creates the other methods (the whole table took 34 ms of each S23 cold start on 2026-10-09, 569
// methods) nor bundles the code only they reach.
//
// A new iOS method: add it to host-entry.ts only. A new Android method: add it to host-entry.ts and its name below.
// check-boot-gates.mjs fails while Kotlin, or the Node harness that runs the shipped bundle (sync-harness.mjs), calls a name
// missing here, while Kotlin passes a method name in a variable anywhere but KOTLIN_FORWARDING_SITES, while the journal
// replays a name missing here, and while a name here is missing from host-entry.ts.
import ts from 'typescript';

export const ANDROID_HOST_METHODS = [
    'abort',
    'aboutRequest',
    'aiRequest',
    'appLock',
    'areaFilter',
    'attachmentRequest',
    'backgroundSync',
    'boot',
    'cancel',
    'captureEdit',
    'captureLines',
    'captureModalLines',
    'captureModalSubmit',
    'captureOpen',
    'capturePicker',
    'captureSnapshot',
    'captureSubmit',
    'captureView',
    'complete',
    'contextAutomation',
    'createProject',
    'editChecklist',
    'editDraft',
    'editorModel',
    'editorSuggestions',
    'focus',
    'focusWindow',
    'inboxCommit',
    'inboxEnd',
    'inboxSkip',
    'inboxStart',
    'inboxStep',
    'ingest',
    'language',
    'logClear',
    'logLine',
    'logLinkHandoff',
    'logShare',
    'menuCommand',
    'menuRead',
    'netCheck',
    'netDeadline',
    'poll',
    'projectDetail',
    'projectFocus',
    'projects',
    'pruneReceipts',
    'reminderDone',
    'remindersCycle',
    'reminderSnooze',
    'remindersStart',
    'resetChecklist',
    'saveDraft',
    'saveSearch',
    'search',
    'setAreaFilter',
    'strings',
    'syncAppState',
    'syncNetwork',
    'syncStart',
    'syncState',
    'taskFocus',
    'taskView',
    'theme',
    'update',
    'widgetsRefresh',
    'window',
];

/** host-entry.ts's `globalThis.MindwtrHost = { … }` literal and its method names, in order. */
export function hostTable(source) {
    const file = ts.createSourceFile('host-entry.ts', source, ts.ScriptTarget.Latest, true);
    const literals = file.statements.filter((statement) => ts.isExpressionStatement(statement)
        && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText(file) === 'globalThis.MindwtrHost'
        && ts.isObjectLiteralExpression(statement.expression.right)).map((statement) => statement.expression.right);
    if (literals.length !== 1) throw new Error(`host-entry.ts: expected one globalThis.MindwtrHost = { … }, found ${literals.length}`);
    const [literal] = literals;
    for (const property of literal.properties) {
        if (!ts.isMethodDeclaration(property) || !ts.isIdentifier(property.name)) {
            throw new Error(`host-entry.ts: MindwtrHost holds methods only, not ${property.getText(file).slice(0, 60)}`);
        }
    }
    return { file, literal, names: literal.properties.map((property) => property.name.text) };
}

/** [source] (host-entry.ts) with only [keep]'s methods in its MindwtrHost table; everything else in the file is unchanged. */
export function androidHostEntry(source, keep = ANDROID_HOST_METHODS) {
    const { file, literal, names } = hostTable(source);
    const missing = keep.filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`host-entry.ts has no MindwtrHost method ${missing.join(', ')} (android-host-table.mjs)`);
    // Each kept method with its leading comments; the commas between them are written again.
    const kept = literal.properties.filter((property) => keep.includes(property.name.text)).map((property) => property.getFullText(file));
    return `${source.slice(0, literal.getStart(file))}{${kept.join(',')},\n}${source.slice(literal.end)}`;
}

/**
 * The only Kotlin sites that pass a host method's name in a variable, each read by hand. A new one fails the gate until it is
 * listed here with why every name that reaches it is in the table.
 */
export const KOTLIN_FORWARDING_SITES = [
    { site: 'CoreHost.kt: getJSFunction(method)', count: 1, why: 'call() looks its method up in the table: every call() is literal or below' },
    { site: 'CoreHost.kt: getJSFunction(name)', count: 1, why: 'global() looks up a polyfill global (__pumpTimers), never the table; its callers are literal' },
    { site: 'CoreHost.kt: call(method, *args)', count: 2, why: 'callLong() and answer() hand their own method on: their callers are literal or below' },
    { site: 'CoreHost.kt: answer(method, args, deadlineMs)', count: 1, why: 'callAsync() hands its own method on: its callers are literal' },
    { site: 'CoreHost.kt: begin(method, args, deadlineMs, done)', count: 2, why: 'callAsync() hands its own method to its queued write\'s Call' },
    { site: 'CoreHost.kt: Call(method, args, deadlineMs, entry, stop, done)', count: 1, why: 'begin() hands its own method on; Call is private and made only here' },
    { site: 'CoreHost.kt: call(call.method, *call.args)', count: 1, why: 'start(): a Call\'s method is a val that only begin() sets' },
    { site: 'CoreHost.kt: answer(entry.method, entry.args.toTypedArray(), deadlineOf(entry.method, entry.args))', count: 1,
        why: 'the journal replay: an entry replays only under a WriteJournal.SHAPES name (journalReplayMethods, checked against the table)' },
];

/** The text of the call's arguments: from just past [open] (its opening parenthesis) to the matching closing one. */
const argumentsAt = (text, open) => {
    let depth = 0;
    for (let at = open; at < text.length; at += 1) {
        const char = text[at];
        if (char === '"') { for (at += 1; at < text.length && text[at] !== '"'; at += text[at] === '\\' ? 2 : 1); continue; }
        if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) return text.slice(open + 1, at);
    }
    return text.slice(open + 1);
};

/**
 * Kotlin's host dispatches in [files] ({ path, text }). [names]: every method named literally. [unverified]: every dispatch
 * whose method is not a literal and is not one of KOTLIN_FORWARDING_SITES (or one past its count), and every way around them.
 * The dispatchers are CoreHost.kt's private `call`, `callAsync`, `callLong`, `answer` and `begin`, and its private `Call` (a
 * queued write, whose method `start` dispatches), never a member such as a JSFunction's `.call`, so only CoreHost.kt can use them; the table itself is reached only through CoreHost.kt's `getJSObject("MindwtrHost")`,
 * and any `.getJSFunction` with a name that is not a literal (a literal one is one of the bundle's globals, __pumpTimers) counts.
 */
export function kotlinHostCalls(files) {
    const names = new Set();
    const variable = [];
    const bypass = [];
    for (const { path, text } of files) {
        const file = path.split('/').pop();
        const line = (index) => text.slice(0, index).split('\n').length;
        if (file === 'CoreHost.kt') {
            for (const name of ['call', 'callAsync', 'callLong', 'answer', 'begin']) {
                if (!new RegExp(`\\bprivate fun ${name}\\(`).test(text)) bypass.push({ site: `${file}: ${name} is not private`, line: 0 });
            }
            if (!/\bprivate class Call\(val method: String,/.test(text)) bypass.push({ site: `${file}: Call is not private with a val method`, line: 0 });
        } else if (text.includes('"MindwtrHost"')) {
            bypass.push({ site: `${file}: reaches "MindwtrHost" outside CoreHost.kt`, line: line(text.indexOf('"MindwtrHost"')) });
        }
        const pattern = file === 'CoreHost.kt' ? /(?<![\w.])(call|callAsync|callLong|answer|begin|Call)\(|\.(getJSFunction)\(/g : /\.(getJSFunction)\(/g;
        for (const match of text.matchAll(pattern)) {
            const callee = match[1] ?? match[2];
            // The dispatchers' own declarations.
            if (/\b(fun|class)\b[^\n(=]*$/.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
            const args = argumentsAt(text, match.index + match[0].length - 1).replace(/\s+/g, ' ').trim();
            const literal = /^"([A-Za-z0-9_]+)"/.exec(args);
            if (literal) { if (callee !== 'getJSFunction') names.add(literal[1]); continue; }
            variable.push({ site: `${file}: ${callee}(${args})`, line: line(match.index) });
        }
    }
    const seen = new Map();
    const unverified = variable.filter(({ site }) => {
        seen.set(site, (seen.get(site) ?? 0) + 1);
        return seen.get(site) > (KOTLIN_FORWARDING_SITES.find((listed) => listed.site === site)?.count ?? 0);
    });
    return { names: [...names].sort(), unverified: [...bypass, ...unverified] };
}

/** WriteJournal.kt's SHAPES keys: the host methods a journal entry replays under (CoreHost's replay passes entry.method on). */
export function journalReplayMethods(writeJournal) {
    const block = /val SHAPES = mapOf\(([\s\S]*?)\n\s*\)/.exec(writeJournal)?.[1];
    if (!block) throw new Error('WriteJournal.kt: no SHAPES = mapOf(…)');
    return [...block.matchAll(/"([A-Za-z0-9_]+)" to listOf\(/g)].map((match) => match[1]).sort();
}
