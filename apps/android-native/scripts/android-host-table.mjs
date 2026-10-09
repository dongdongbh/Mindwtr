// The Android bundle's MindwtrHost table: the methods of host-entry.ts that Android calls, and no others.
//
// host-entry.ts holds every host method once, for both platforms. iOS bundles it as written
// (apps/ios-native/scripts/build-bundle.mjs). Android's build-bundle.mjs first drops every method not named below, so an
// Android start neither creates the other methods (the whole table took 34 ms of each S23 cold start on 2026-10-09, 569
// methods) nor bundles the code only they reach.
//
// A new iOS method: add it to host-entry.ts only. A new Android method: add it to host-entry.ts and its name below.
// check-boot-gates.mjs fails while Kotlin, or the Node harness that runs the shipped bundle (sync-harness.mjs), calls a name
// missing here, and while a name here is missing from host-entry.ts.
import ts from 'typescript';

export const ANDROID_HOST_METHODS = [
    'abort',
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
