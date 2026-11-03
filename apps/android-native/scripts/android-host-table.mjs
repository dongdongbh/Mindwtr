


import ts from 'typescript';

export const ANDROID_HOST_METHODS = [
    'abort',
    'aboutRequest',
    'aiRequest',
    'appLock',
    'appSearchApply',
    'appSearchIds',
    'appSearchStart',
    'archiveRetention',
    'areaFilter',
    'attachmentRequest',
    'backgroundSync',
    'backupDocumentCommit',
    'backupDocumentFailureModel',
    'backupDocumentInspectFile',
    'backupDocumentPrepareFile',
    'backupDocumentResultModel',
    'backupLibraryBytes',
    'backupSnapshotRestoreModel',
    'backupUndoHold',
    'boot',
    'bootRecovery',
    'calendarRequest',
    'cancel',
    'captureEdit',
    'captureLines',
    'captureModalLines',
    'captureModalSubmit',
    'captureOpen',
    'capturePicker',
    'captureSnapshotFile',
    'captureSubmit',
    'captureView',
    'complete',
    'completeUndo',
    'contextAutomation',
    'createProject',
    'dataChannelRoundTrip',
    'dataExportFile',
    'editChecklist',
    'editDraft',
    'editorModel',
    'editorSuggestions',
    'focus',
    'focusWindow',
    'gmailRequest',
    'inboxCommit',
    'inboxDecisionUndo',
    'inboxEnd',
    'inboxSkip',
    'inboxStart',
    'inboxStep',
    'ingest',
    'ingestAudio',
    'language',
    'languageSaved',
    'legacyCheck',
    'logClear',
    'logLine',
    'logLinkHandoff',
    'logShare',
    'menuCommand',
    'menuRead',
    'netCheck',
    'netDeadline',
    'poll',

    'pomodoroAlarmPlan',
    'pomodoroAlarmSaved',
    'pomodoroLegacyAlert',
    'pomodoroPanelRead',
    'pomodoroSessionRead',
    'pomodoroTasks',
    'pomodoroTransitionCommit',
    'pomodoroTransitionOutcome',
    'pomodoroTransitionPrepare',
    'pomodoroTransitionValidate',
    'projectDetail',
    'projectFocus',
    'projectList',
    'projects',
    'pruneReceipts',
    'pullSync',
    'reminderDone',
    'reminderSnooze',
    'remindersCycle',
    'remindersStart',
    'resetChecklist',
    'resumeActivation',
    'saveDraft',
    'saveSearch',
    'search',
    'sessionRestoreRead',
    'sessionRestoreWrite',
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
    'voiceRequest',
    'widgetsRefresh',
    'saveWarm',
    'window',
];


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


export function androidHostEntry(source, keep = ANDROID_HOST_METHODS) {
    const { file, literal, names } = hostTable(source);
    const missing = keep.filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`host-entry.ts has no MindwtrHost method ${missing.join(', ')} (android-host-table.mjs)`);

    const kept = literal.properties.filter((property) => keep.includes(property.name.text)).map((property) => property.getFullText(file));
    return `${source.slice(0, literal.getStart(file))}{${kept.join(',')},\n}${source.slice(literal.end)}`;
}


export const KOTLIN_FORWARDING_SITES = [
    { site: 'CoreHost.kt: getJSFunction(method)', count: 1, why: 'call() looks its method up in the table: every call() is literal or below' },
    { site: 'CoreHost.kt: getJSFunction(name)', count: 1, why: 'global() looks up a polyfill global (__pumpTimers), never the table; its callers are literal' },
    { site: 'CoreHost.kt: call(method, *args)', count: 2, why: 'callLong() and answer() hand their own method on: their callers are literal or below' },
    { site: 'CoreHost.kt: answer(method, sent, deadlineMs)', count: 1,
        why: 'answerChecked() hands its own method on (a backup commit with its checked plan put in): callAsync\'s nested path, whose callers are literal, and the journal replay' },
    { site: 'CoreHost.kt: begin(method, args, deadlineMs, done)', count: 2, why: 'callAsync() hands its own method to its queued write\'s Call' },
    { site: 'CoreHost.kt: Call(method, args, deadlineMs, entry, stop, done)', count: 1, why: 'begin() hands its own method on; Call is private and made only here' },
    { site: 'CoreHost.kt: answerChecked(method, args, deadlineMs)', count: 1, why: 'callAsync()\'s nested path hands its own method on: its callers are literal' },
    { site: 'CoreHost.kt: answerChecked(entry.method, entry.args.toTypedArray(), deadline(entry.method, entry.args))', count: 1,
        why: 'the journal replay: an entry replays only under a WriteJournal.SHAPES name (journalReplayMethods, checked against the table)' },
    { site: 'CoreHost.kt: call(call.method, *sent)', count: 1, why: 'start(): a Call\'s method is a val that only begin() sets (its arguments with a backup commit\'s checked plan put in)' },
];


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


export function kotlinHostCalls(files) {
    const names = new Set();
    const variable = [];
    const bypass = [];
    for (const { path, text } of files) {
        const file = path.split('/').pop();
        const line = (index) => text.slice(0, index).split('\n').length;
        if (file === 'CoreHost.kt') {
            for (const name of ['call', 'callAsync', 'callLong', 'answer', 'answerChecked', 'begin']) {
                if (!new RegExp(`\\bprivate fun ${name}\\(`).test(text)) bypass.push({ site: `${file}: ${name} is not private`, line: 0 });
            }
            if (!/\bprivate class Call\(val method: String,/.test(text)) bypass.push({ site: `${file}: Call is not private with a val method`, line: 0 });
        } else if (text.includes('"MindwtrHost"')) {
            bypass.push({ site: `${file}: reaches "MindwtrHost" outside CoreHost.kt`, line: line(text.indexOf('"MindwtrHost"')) });
        }
        const pattern = file === 'CoreHost.kt' ? /(?<![\w.])(call|callAsync|callLong|answer|answerChecked|begin|Call)\(|\.(getJSFunction)\(/g : /\.(getJSFunction)\(/g;
        for (const match of text.matchAll(pattern)) {
            const callee = match[1] ?? match[2];

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


export function journalReplayMethods(writeJournal) {
    const block = /val SHAPES = mapOf\(([\s\S]*?)\n\s*\)/.exec(writeJournal)?.[1];
    if (!block) throw new Error('WriteJournal.kt: no SHAPES = mapOf(…)');
    return [...block.matchAll(/"([A-Za-z0-9_]+)" to listOf\(/g)].map((match) => match[1]).sort();
}
